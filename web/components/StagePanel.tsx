"use client";

import { useState } from "react";
import { checkAnchor, type NodeType } from "../lib/types.ts";
import { ops, peekNodeId, NODE_TYPES, type StageModel, type Validation } from "../lib/staging.ts";
import { NODE_STYLE } from "../lib/palette.ts";
import type { Selection } from "./GraphView.tsx";

type Update = (fn: (m: StageModel) => StageModel) => void;

export default function StagePanel({
  model,
  validation,
  update,
  onSelect,
  onDownload,
  onReset,
}: {
  model: StageModel;
  validation: Validation;
  update: Update;
  onSelect: (s: Selection) => void;
  onDownload: () => void;
  onReset: () => void;
}) {
  const [addType, setAddType] = useState<NodeType>("claim");
  const [addText, setAddText] = useState("");

  const live = model.nodes.filter((n) => !n.dropped);
  const byType: Record<string, number> = {};
  for (const n of live) byType[n.type] = (byType[n.type] ?? 0) + 1;

  const anchored = live.filter((n) => n.anchor && checkAnchor(model.meta.extractedText, n.anchor) !== "missing").length;

  const droppedNodes = model.nodes.filter((n) => n.dropped);
  const droppedEdges = model.edges.filter((e) => e.dropped);
  const invalidEdges = model.edges.filter((e) => !e.dropped && validation.edgeStatus.get(e.id)?.valid === false);
  const needText = [...validation.nodeNeedsText];

  const addNode = () => {
    const id = peekNodeId(model);
    update((m) => ops.addNode(m, addType, { text: addText.trim() }));
    setAddText("");
    onSelect({ kind: "node", id });
  };

  const setPaper = (patch: Parameters<typeof ops.editPaper>[1]) => update((m) => ops.editPaper(m, patch));
  const authors = model.paper?.authors ?? [];
  const setAuthor = (i: number, patch: { name?: string; orcid?: string }) => {
    const next = authors.map((a, j) => (j === i ? { ...a, ...patch } : a));
    setPaper({ authors: next });
  };

  return (
    <div className="report">
      <div className="rail-bar">
        <button className="ghost sm" onClick={onReset}>← New extraction</button>
        <button className="run sm" onClick={onDownload}>↓ Export graph</button>
      </div>

      {/* Ready-to-export gate */}
      <div className={`gate ${validation.publishable ? "ok" : "bad"}`}>
        {validation.publishable
          ? <><b>✓ Ready</b> — {validation.liveNodeCount} nodes · {validation.liveEdgeCount} valid relations</>
          : <><b>Fix to export</b> — {needText.length} empty node{needText.length === 1 ? "" : "s"}{invalidEdges.length ? `, ${invalidEdges.length} bad relation${invalidEdges.length === 1 ? "" : "s"} excluded` : ""}</>}
      </div>

      {(needText.length > 0 || invalidEdges.length > 0) && (
        <div className="issues">
          {needText.map((id) => (
            <button key={id} className="issue" onClick={() => onSelect({ kind: "node", id })}>⚠ node <b>{id}</b> has no text</button>
          ))}
          {invalidEdges.map((e) => (
            <button key={e.id} className="issue" onClick={() => onSelect({ kind: "edge", id: e.id })}>✕ {e.relation}: {validation.edgeStatus.get(e.id)?.reason}</button>
          ))}
        </div>
      )}

      {/* Paper metadata (editable) */}
      <details className="card-details">
        <summary>Paper metadata</summary>
        <label className="field"><span>Title</span><input value={model.paper?.title ?? ""} onChange={(e) => setPaper({ title: e.target.value || undefined })} /></label>
        <label className="field"><span>DOI</span><input value={model.paper?.doi ?? ""} onChange={(e) => setPaper({ doi: e.target.value || undefined })} /></label>
        <label className="field"><span>License</span><input value={model.paper?.license ?? ""} onChange={(e) => setPaper({ license: e.target.value || undefined })} placeholder="CC BY 4.0" /></label>
        <div className="field"><span>Authors</span>
          {authors.map((a, i) => (
            <div key={i} className="author-row">
              <input value={a.name} onChange={(e) => setAuthor(i, { name: e.target.value })} placeholder="name" />
              <input value={a.orcid ?? ""} onChange={(e) => setAuthor(i, { orcid: e.target.value || undefined })} placeholder="ORCID" />
              <button className="x" onClick={() => setPaper({ authors: authors.filter((_, j) => j !== i) })}>×</button>
            </div>
          ))}
          <button className="ghost sm" onClick={() => setPaper({ authors: [...authors, { name: "" }] })}>＋ author</button>
        </div>
      </details>

      {/* Live legend + counts */}
      <div className="legend">
        {NODE_TYPES.map((t) => (
          <div key={t} className="legend-row">
            <span className="legend-dot" style={{ background: NODE_STYLE[t].color }} />
            <span>{NODE_STYLE[t].label}</span>
            <span className="legend-count">{byType[t] ?? 0}</span>
          </div>
        ))}
      </div>

      <div className="stat-row">
        <div className="stat"><b>{validation.liveNodeCount}</b><span>nodes</span></div>
        <div className="stat"><b>{validation.liveEdgeCount}</b><span>relations</span></div>
        <div className="stat"><b>{anchored}/{validation.liveNodeCount}</b><span>anchors</span></div>
      </div>

      {(model.meta.truncated || model.meta.chunks > 1) && (
        <div className={`banner ${model.meta.truncated ? "warn" : "info"}`}>
          {model.meta.truncated
            ? `Very long paper — read in ${model.meta.chunks} windows; a tail of ${model.meta.fullChars.toLocaleString()} chars was left uncovered.`
            : `Read in ${model.meta.chunks} windows, merged (${model.meta.fullChars.toLocaleString()} chars).`}
        </div>
      )}

      {/* Add a node */}
      <details className="card-details">
        <summary>Add a node</summary>
        <div className="field">
          <select value={addType} onChange={(e) => setAddType(e.target.value as NodeType)}>
            {NODE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="field">
          <input value={addText} onChange={(e) => setAddText(e.target.value)} placeholder="node text…" onKeyDown={(e) => { if (e.key === "Enter" && addText.trim()) addNode(); }} />
        </div>
        <button className="ghost sm" disabled={!addText.trim()} onClick={addNode}>＋ Add node</button>
        <p className="muted tiny">Then drag from its dots to connect it.</p>
      </details>

      {/* Recovery zone */}
      {(droppedNodes.length > 0 || droppedEdges.length > 0) && (
        <details className="card-details recovery" open>
          <summary>Dropped — restorable ({droppedNodes.length + droppedEdges.length})</summary>
          {droppedNodes.map((n) => (
            <div key={n.id} className="warn-item">
              <span className="muted">{n.type}: {(n.text || n.id).slice(0, 40)}</span>
              <button className="ghost xs" onClick={() => update((m) => ops.restoreNode(m, n.id))}>↩ restore</button>
            </div>
          ))}
          {droppedEdges.map((e) => (
            <div key={e.id} className="warn-item">
              <span className="muted">{e.subject} →{e.relation}→ {e.object}</span>
              <button className="ghost xs" onClick={() => update((m) => ops.restoreEdge(m, e.id))}>↩ restore</button>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
