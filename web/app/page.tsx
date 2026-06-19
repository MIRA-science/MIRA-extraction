"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import GraphView, { type Selection } from "../components/GraphView.tsx";
import Inspector from "../components/Inspector.tsx";
import InputForm, { type RunPayload } from "../components/InputForm.tsx";
import StagePanel from "../components/StagePanel.tsx";
import type { ExtractResponse } from "../lib/types.ts";
import { pdfToTextInBrowser } from "../lib/pdf-client.ts";
import {
  buildStageModel,
  validate,
  exportGraph,
  legalRelationsForPair,
  ops,
  peekEdgeId,
  type StageModel,
} from "../lib/staging.ts";

/** Seconds → "42s" or "1:23" for the elapsed-time liveness readout. */
function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Read the /api/extract response. The success path is a newline-delimited JSON stream:
 * "status" lines drive the progress message, "ping" lines are keepalive, and a final
 * "result"/"error" line carries the payload. A non-stream body (a JSON {error} from
 * server-side validation, or a plain-text platform error like a 413) is surfaced as a clear
 * message. Throws on error; returns the ExtractResponse on success.
 */
async function readExtractStream(
  res: Response,
  onStatus: (message: string) => void,
): Promise<ExtractResponse> {
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("ndjson") || !res.body) {
    const raw = await res.text();
    let message =
      res.status === 413
        ? "That file is too large to upload (server limit ~4.5 MB). Paste the paper's text instead, or use a smaller PDF."
        : `Server returned an unexpected response (HTTP ${res.status}). Please try again.`;
    try {
      const parsed = JSON.parse(raw) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      /* keep the status-based message */
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: ExtractResponse | null = null;
  let streamError: string | null = null;

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: { type?: string; message?: string; data?: ExtractResponse };
    try {
      event = JSON.parse(trimmed);
    } catch {
      return; // ignore a stray non-JSON line
    }
    if (event.type === "status" && event.message) onStatus(event.message);
    else if (event.type === "result" && event.data) data = event.data;
    else if (event.type === "error") streamError = event.message || "Extraction failed.";
    // "ping" keepalive lines are intentionally ignored
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      handleLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  handleLine(buffer); // any trailing line without a newline

  if (streamError) throw new Error(streamError);
  if (!data) {
    throw new Error(
      "The server ended the response before finishing — the paper may be too long. Try a shorter excerpt or paste just the relevant sections.",
    );
  }
  return data;
}

export default function Home() {
  const [model, setModel] = useState<StageModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);

  const validation = useMemo(() => (model ? validate(model) : null), [model]);

  // Tick an elapsed-seconds counter while a run is in flight — a live "still working" signal
  // (alongside the streamed stage messages) so a long extraction never looks frozen.
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const update = useCallback((fn: (m: StageModel) => StageModel) => {
    setModel((prev) => (prev ? fn(prev) : prev));
  }, []);

  const run = useCallback(async (p: RunPayload) => {
    setBusy(true);
    setElapsed(0);
    setError(null);
    setNotice(null);
    setSelection(null);
    setProgress("Preparing…");
    try {
      const fd = new FormData();
      if (p.file && /\.pdf$/i.test(p.file.name)) {
        // Parse the PDF in the browser and upload TEXT, not the raw bytes — Vercel rejects a
        // request body over ~4.5 MB before the function runs. Fall back to a server-side file
        // upload if browser extraction fails (odd PDF / worker) or finds no text layer.
        let extracted = "";
        try {
          extracted = (
            await pdfToTextInBrowser(p.file, (page, total) =>
              setProgress(`Reading PDF — page ${page} of ${total}…`),
            )
          ).trim();
        } catch {
          extracted = "";
        }
        if (extracted) {
          fd.append("text", extracted);
          fd.append("filename", p.file.name);
        } else {
          fd.append("file", p.file);
        }
      } else if (p.file) {
        fd.append("file", p.file); // .txt/.md — already small
      } else {
        fd.append("text", p.text);
      }
      if (p.attributedTo) fd.append("attributedTo", p.attributedTo);
      if (p.apiKey) fd.append("apiKey", p.apiKey);

      setProgress("Uploading & contacting the model…");
      const res = await fetch("/api/extract", { method: "POST", body: fd });
      const data = await readExtractStream(res, setProgress);
      setModel(buildStageModel(data));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setModel(null);
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }, []);

  // Draw-to-connect: pick the (only) legal relation for the dragged direction; if several are
  // legal, take the first and let the user adjust it in the inspector; if none, say so.
  const handleConnect = useCallback((subject: string, object: string) => {
    setModel((prev) => {
      if (!prev) return prev;
      const s = prev.nodes.find((n) => n.id === subject);
      const o = prev.nodes.find((n) => n.id === object);
      if (!s || !o) return prev;
      const legal = legalRelationsForPair(s.type, o.type);
      if (legal.length === 0) {
        setNotice(`No legal relation from ${s.type} → ${o.type}. Try the other direction.`);
        return prev;
      }
      const id = peekEdgeId(prev);
      setNotice(null);
      setSelection({ kind: "edge", id });
      return ops.addEdge(prev, legal[0], subject, object);
    });
  }, []);

  const download = useCallback(() => {
    if (!model || !validation) return;
    const graph = exportGraph(model, validation, new Date().toISOString());
    const blob = new Blob([JSON.stringify(graph, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(model.meta.source || "paper").replace(/[^a-z0-9._-]+/gi, "_")}.graph.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [model, validation]);

  const reset = useCallback(() => {
    setModel(null);
    setSelection(null);
    setError(null);
    setNotice(null);
    setProgress(null);
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="brand">
          <h1>MIRA Graph Extractor</h1>
          <p className="muted small">
            A paper → an editable graph of <i>question · claim · evidence · study · source</i>. Extract, then refine before export.
          </p>
        </header>

        {!model && <InputForm busy={busy} onRun={run} />}
        {error && <div className="banner error">{error}</div>}

        {model && validation && (
          <StagePanel model={model} validation={validation} update={update} onSelect={setSelection} onDownload={download} onReset={reset} />
        )}
      </aside>

      <main className="canvas">
        {model && validation ? (
          <GraphView
            nodes={model.nodes}
            edges={model.edges}
            validation={validation}
            selection={selection}
            onSelect={setSelection}
            onConnect={handleConnect}
          />
        ) : (
          <div className="placeholder">
            <div className="placeholder-inner">
              <div className={busy ? "placeholder-mark spin" : "placeholder-mark"}>◇</div>
              {busy ? (
                <>
                  <p>{progress ?? "Reading the paper and building the graph…"}</p>
                  <p className="muted tiny">
                    {formatElapsed(elapsed)} elapsed · large papers run several model passes and can take 1–3 minutes
                  </p>
                </>
              ) : (
                <p>Your editable graph will appear here.</p>
              )}
            </div>
          </div>
        )}
        {notice && <div className="notice" onClick={() => setNotice(null)}>{notice}</div>}
      </main>

      {model && validation && (
        <Inspector selection={selection} model={model} validation={validation} update={update} onSelect={setSelection} />
      )}
    </div>
  );
}
