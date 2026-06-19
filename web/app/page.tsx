"use client";

import { useCallback, useMemo, useState } from "react";
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

export default function Home() {
  const [model, setModel] = useState<StageModel | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(null);

  const validation = useMemo(() => (model ? validate(model) : null), [model]);

  const update = useCallback((fn: (m: StageModel) => StageModel) => {
    setModel((prev) => (prev ? fn(prev) : prev));
  }, []);

  const run = useCallback(async (p: RunPayload) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setSelection(null);
    try {
      const fd = new FormData();
      if (p.file && /\.pdf$/i.test(p.file.name)) {
        // Parse the PDF in the browser and upload TEXT, not the raw bytes — Vercel rejects a
        // request body over ~4.5 MB before the function runs. Fall back to a server-side file
        // upload if browser extraction fails (odd PDF / worker) or finds no text layer.
        let extracted = "";
        try {
          extracted = (await pdfToTextInBrowser(p.file)).trim();
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

      const res = await fetch("/api/extract", { method: "POST", body: fd });
      // Read as text first: a platform error (e.g. a 413 when an upload tops Vercel's ~4.5 MB
      // body limit) returns a plain-text body, and res.json() on it throws an opaque
      // "Unexpected token" error. Parse defensively and surface something actionable.
      const raw = await res.text();
      let data: ExtractResponse;
      try {
        data = JSON.parse(raw) as ExtractResponse;
      } catch {
        throw new Error(
          res.status === 413
            ? "That file is too large to upload (server limit ~4.5 MB). Paste the paper's text instead, or use a smaller PDF."
            : `Server returned a non-JSON response (HTTP ${res.status}). Please try again.`,
        );
      }
      if (!res.ok || data.error) throw new Error(data.error || `Request failed (${res.status})`);
      setModel(buildStageModel(data));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setModel(null);
    } finally {
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
              <div className="placeholder-mark">◇</div>
              <p>{busy ? "Reading the paper and building the graph…" : "Your editable graph will appear here."}</p>
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
