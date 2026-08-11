"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import GraphView, { type Selection } from "../components/GraphView.tsx";
import Inspector from "../components/Inspector.tsx";
import InputForm, { type RunPayload } from "../components/InputForm.tsx";
import StagePanel from "../components/StagePanel.tsx";
import type { ExtractResponse } from "../lib/types.ts";
import { checkAnchor } from "../lib/types.ts";
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
 * Read the /api/extract response. The success path is a newline-delimited JSON
 * stream: "status" lines drive the progress message, "ping" lines are keepalive,
 * and a final "result"/"error" line carries the payload.
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
      return;
    }
    if (event.type === "status" && event.message) onStatus(event.message);
    else if (event.type === "result" && event.data) data = event.data;
    else if (event.type === "error") streamError = event.message || "Extraction failed.";
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
  handleLine(buffer);

  if (streamError) throw new Error(streamError);
  if (!data) throw new Error("The server ended the response before finishing — please try again.");
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
  const anchored = useMemo(() => {
    if (!model) return 0;
    return model.nodes.filter(
      (n) => !n.dropped && n.anchor && checkAnchor(model.meta.extractedText, n.anchor) !== "missing",
    ).length;
  }, [model]);

  // elapsed ticker — a live "still working" signal beside the streamed stages
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

  // esc closes the inspector — the viewer's habit
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelection(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
        // Parse the PDF in the browser and upload TEXT, not the raw bytes.
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
        fd.append("file", p.file);
      } else {
        fd.append("text", p.text);
      }
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

  // Draw-to-connect: pick the (only) legal relation for the dragged direction.
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
    const out = exportGraph(model, validation, new Date().toISOString());
    const save = (obj: unknown, name: string) => {
      const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    };
    save(out.jsonld, `${out.slug}.mira.jsonld`); // canonical MIRA JSON-LD — the headline artifact
    save(out.graph, `${out.slug}.graph.json`); // working graph (debug artifact)
  }, [model, validation]);

  const reset = useCallback(() => {
    setModel(null);
    setSelection(null);
    setError(null);
    setNotice(null);
    setProgress(null);
  }, []);

  return (
    <div className="shell">
      <div className="grain" aria-hidden="true" />
      <div className="vignette" aria-hidden="true" />

      {/* -------------------------------------------- masthead (the viewer's) */}
      <header className="masthead">
        <div className="mark">
          <span className="mark-glyph" aria-hidden="true" />
          <div className="mark-text">
            <h1>MIRA extraction</h1>
            <p>graph extractor · staging viewer</p>
          </div>
        </div>

        <div className="breadcrumb">
          {model ? (
            <>
              staging › <b>{model.meta.source}</b>
              {model.meta.pieces > 1 ? ` · ${model.meta.pieces} pieces` : ""}
            </>
          ) : busy ? (
            "extracting…"
          ) : (
            "no draft — bring a paper"
          )}
        </div>

        <div className="readout">
          <div className="stat">
            <b>{validation ? validation.liveNodeCount : "·"}</b>
            <span>records</span>
          </div>
          <div className="stat">
            <b>{validation ? validation.liveEdgeCount : "·"}</b>
            <span>relations</span>
          </div>
          <div className="stat">
            <b>{model ? `${anchored}/${validation?.liveNodeCount ?? 0}` : "·"}</b>
            <span>anchored</span>
          </div>
          <div className={busy ? "pulse busy" : model ? "pulse ok" : "pulse"}>
            <span className="dot" />
            <span className="pulse-label">{busy ? "extracting" : model ? "draft" : "idle"}</span>
          </div>
        </div>

        <div className="mast-actions">
          {model && (
            <button className="compose-new" onClick={reset} title="Discard this draft and start over">
              ← new
            </button>
          )}
          <button
            className="compose-new export-mira"
            disabled={!model || !validation?.publishable}
            onClick={download}
            title="Download the graph as canonical MIRA JSON-LD"
          >
            ⤓ MIRA
          </button>
        </div>
      </header>

      {/* -------------------------------------------- the graph + overlays */}
      <main>
        {model && validation && (
          <GraphView
            nodes={model.nodes}
            edges={model.edges}
            validation={validation}
            selection={selection}
            onSelect={setSelection}
            onConnect={handleConnect}
          />
        )}

        {/* the staging rail — docked left over the canvas, like the viewer's */}
        {model && validation && (
          <aside className="rail">
            <div className="opp-bar">
              <span className="rb-kind">staging</span>
              <span className="rb-title">review → export</span>
            </div>
            <div className="rail-body">
              <StagePanel
                model={model}
                validation={validation}
                selection={selection}
                update={update}
                onSelect={setSelection}
                onDownload={download}
                onReset={reset}
              />
            </div>
          </aside>
        )}

        {/* the inspector — right slide-in, esc closes */}
        {model && validation && selection && (
          <section className="inspector" data-open="true">
            <button className="inspector-close" onClick={() => setSelection(null)}>
              esc
            </button>
            <Inspector
              selection={selection}
              model={model}
              validation={validation}
              update={update}
              onSelect={setSelection}
            />
          </section>
        )}

        {/* the importer — a centered overlay panel until a draft exists */}
        {!model && (
          <div className="importer-overlay">
            <div className="importer-panel">
              <div className="opp-bar">
                <span className="rb-kind">import</span>
                <span className="rb-title">decompose a paper → graph</span>
              </div>
              <div className="importer-body">
                {busy ? (
                  <div className="imp-status">
                    <div className="placeholder-mark spin">◇</div>
                    <p>{progress ?? "Working…"}</p>
                    <p className="muted tiny">
                      {formatElapsed(elapsed)} elapsed · a whole paper is one model call on the free
                      chain (~1–3 min); very long papers are read in pieces
                    </p>
                  </div>
                ) : (
                  <>
                    {error && <div className="banner error">{error}</div>}
                    <InputForm busy={busy} onRun={run} />
                  </>
                )}
              </div>
            </div>
          </div>
        )}

        {notice && (
          <div className="notice" onClick={() => setNotice(null)}>
            {notice}
          </div>
        )}
      </main>

      {/* -------------------------------------------- the bottom hud strip */}
      <footer className="hud">
        <span>
          staging viewer · click a node or relation to edit · drag dot → dot to draw a relation ·
          esc closes the inspector
        </span>
        <span>mira-extraction · nothing is published or signed</span>
      </footer>
    </div>
  );
}
