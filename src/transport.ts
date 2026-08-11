/**
 * transport.ts — the one LLM transport: an OpenRouter chat call with a
 * streaming (SSE) reader, watchdogs, and bounded retries.
 *
 * MODEL POLICY — one pinned model, free by default (the default id ends in
 * ":free", so a default run can never bill a provider key). No fallback chain:
 * a response served by any model other than the requested one is an error.
 * Overridable per call.
 *
 * STREAMING DISCIPLINE — a generation runs until COMPLETED, never killed by a
 * fixed wall. `stream: true` makes OpenRouter send SSE chunks plus keep-alive
 * comments while the model works. Two local watchdogs bound the wait:
 *   - IDLE: abort when NOTHING (not even a keep-alive) arrives for
 *     idleTimeoutMs — a dead connection.
 *   - PROGRESS: abort when no MODEL OUTPUT (content or reasoning tokens)
 *     arrives for progressTimeoutMs — a stuck queue slot. Keep-alives re-arm
 *     only the idle timer; the progress clock resets on every real token, so a
 *     generation that keeps producing is never killed.
 *
 * Ported upstream by SciOS from the RRGI deployment's transport
 * (decompose-pdf.mjs / extract.mjs, field-tested at graph.scios.tech).
 * Last synced with the RRGI pipeline: 2026-08-10.
 */

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

/** The pinned default model (winner of RRGI's 2026-07 structure bake-off). */
export const DEFAULT_MODEL = "nvidia/nemotron-3-ultra-550b-a55b:free";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface TransportOptions {
  apiKey: string;
  /** Model to use (default DEFAULT_MODEL); no fallback. */
  model?: string;
  temperature?: number; // default 0.2 — extraction wants determinism
  maxOutputTokens?: number; // default 60_000 — free chains REASON before answering; thinking tokens count against this cap
  idleTimeoutMs?: number; // default 120_000
  progressTimeoutMs?: number; // default 900_000
  retries?: number; // total attempts on retryable failures (default 5)
  /** Progress hook: fires on every real model token burst. The free chains
   *  REASON before answering, so `kind` distinguishes streamed thinking from
   *  the actual answer — both are liveness. */
  onToken?: (charsSoFar: number, kind: "reasoning" | "content") => void;
}

export interface TransportResult {
  content: string;
  model: string;
  generationId: string | null;
  /** OpenRouter usage accounting (incl. cost) — the free-only receipt. */
  usage: unknown | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const retryable = (status: number) =>
  status === 0 || status === 408 || status === 429 || (status >= 500 && status <= 599);

interface OnceResult {
  ok: boolean;
  status?: number;
  reason?: string;
  content?: string;
  model?: string;
  id?: string;
  usage?: unknown;
}

async function callOnce(messages: ChatMessage[], o: Required<Pick<TransportOptions,
  "apiKey" | "model" | "temperature" | "maxOutputTokens" | "idleTimeoutMs" | "progressTimeoutMs">> &
  Pick<TransportOptions, "onToken">): Promise<OnceResult> {
  const ctrl = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  let progressTripped = false;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ctrl.abort(), o.idleTimeoutMs);
  };
  const armProgress = () => {
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = setTimeout(() => { progressTripped = true; ctrl.abort(); }, o.progressTimeoutMs);
  };
  try {
    armIdle();
    armProgress();
    const resp = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: "Bearer " + o.apiKey,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/MIRA-science/MIRA-extraction",
        "X-Title": "MIRA-extraction",
      },
      body: JSON.stringify({
        model: o.model,
        messages,
        temperature: o.temperature,
        max_tokens: o.maxOutputTokens,
        stream: true, // chunks + keep-alives — a working generation is never dropped
        usage: { include: true }, // the final chunk carries {cost, ...} — the free-only receipt
      }),
    });
    if (!resp.ok) {
      let detail = "";
      try { detail = (await resp.text()).slice(0, 300); } catch { /* ignore */ }
      return { ok: false, status: resp.status, reason: `HTTP ${resp.status}${detail ? ` — ${detail}` : ""}` };
    }
    if (!resp.body) return { ok: false, status: 502, reason: "no response body" };

    // SSE accumulation: "data: " lines carry JSON chunks; ":" lines are
    // keep-alive comments. EVERY arriving byte re-arms the idle watchdog; only
    // real model output re-arms the progress watchdog.
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "", content = "", model = "", id = "";
    let reasoningChars = 0;
    let usage: unknown = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || line.startsWith(":") || !line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") continue;
        let j: any;
        try { j = JSON.parse(payload); } catch { continue; }
        if (j.error)
          return { ok: false, status: 502, reason: `stream error: ${String(j.error?.message || JSON.stringify(j.error)).slice(0, 200)}` };
        if (j.id) id = j.id;
        if (j.model) model = j.model;
        if (j.usage) usage = j.usage;
        const rdelta = j.choices?.[0]?.delta?.reasoning;
        if (typeof rdelta === "string" && rdelta) {
          reasoningChars += rdelta.length;
          armProgress(); // streamed reasoning IS model output
          o.onToken?.(reasoningChars, "reasoning");
        }
        const delta = j.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) {
          content += delta;
          armProgress();
          o.onToken?.(content.length, "content");
        }
      }
    }
    if (!content.trim()) return { ok: false, status: 502, reason: "empty streamed content" };
    // Responses may drop the ":free"-style variant suffix — compare base ids.
    if (model && model.split(":")[0] !== o.model.split(":")[0])
      return { ok: false, status: 200, reason: `model mismatch: asked for ${o.model}, answered by ${model}` };
    return { ok: true, content, model: model || o.model, id, usage };
  } catch (e: any) {
    if (e?.name === "AbortError") {
      return {
        ok: false,
        status: 408,
        reason: progressTripped
          ? `progress timeout: no model output for ${o.progressTimeoutMs}ms (keep-alives only — stuck stream)`
          : `idle timeout: no stream activity for ${o.idleTimeoutMs}ms`,
      };
    }
    return { ok: false, status: 0, reason: e?.message || String(e) };
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (progressTimer) clearTimeout(progressTimer);
  }
}

/**
 * One chat call with bounded exponential-backoff retries on transient failures
 * (timeouts, 429s, 5xx, network drops). Non-retryable failures and exhausted
 * retries throw with the last reason. `label` names the call in the error.
 */
export async function streamChat(
  messages: ChatMessage[],
  options: TransportOptions,
  label = "",
): Promise<TransportResult> {
  const o = {
    apiKey: options.apiKey,
    model: options.model ?? DEFAULT_MODEL,
    temperature: options.temperature ?? 0.2,
    maxOutputTokens: options.maxOutputTokens ?? 60_000,
    idleTimeoutMs: options.idleTimeoutMs ?? 120_000,
    progressTimeoutMs: options.progressTimeoutMs ?? 900_000,
    onToken: options.onToken,
  };
  const attempts = Math.max(1, options.retries ?? 5);
  let last: OnceResult | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const res = await callOnce(messages, o);
    if (res.ok)
      return { content: res.content!, model: res.model!, generationId: res.id || null, usage: res.usage ?? null };
    last = res;
    if (!retryable(res.status ?? 0) || attempt === attempts) break;
    const backoff = Math.min(30_000, 1500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 750);
    await sleep(backoff);
  }
  throw new Error(`LLM call failed${label ? ` (${label})` : ""}: ${last?.reason || "unknown"}`);
}
