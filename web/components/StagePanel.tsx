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
  selection,
  update,
  onSelect,
  onDownload,
  onReset,
}: {
  model: StageModel;
  validation: Validation;
  selection: Selection;
  update: Update;
  onSelect: (s: Selection) => void;
  onDownload: () => void;
  onReset: () => void;
}) {
  const [addType, setAddType] = useState<NodeType>("Claim");
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

      {/* The record sections — the RRGI rail: every record grouped by type,
          colored dot headers, click a row to open it in the inspector. */}
      {NODE_TYPES.filter((t) => (byType[t] ?? 0) > 0).map((t) => (
        <div key={t} className="sec">
          <div className="sec-hd" style={{ color: NODE_STYLE[t].color }}>
            <span className="sec-dot" style={{ background: NODE_STYLE[t].color }} />
            {NODE_STYLE[t].label}s
            <span className="sec-count">{byType[t]}</span>
          </div>
          {live.filter((n) => n.type === t).map((n) => (
            <div
              key={n.id}
              className={selection?.kind === "node" && selection.id === n.id ? "row selected" : "row"}
            >
              <span className="row-dot" style={{ background: NODE_STYLE[t].color, color: NODE_STYLE[t].color }} />
              <div className="row-main">
                <textarea
                  className="row-edit"
                  rows={2}
                  placeholder="text is required…"
                  value={n.text}
                  onChange={(e) => update((m) => ops.editNode(m, n.id, { text: e.target.value }))}
                />
                <div className="row-actions">
                  <select
                    className="row-type"
                    value={n.type}
                    title="change type — relations re-check live"
                    onChange={(e) => update((m) => ops.editNode(m, n.id, { type: e.target.value as NodeType }))}
                  >
                    {NODE_TYPES.map((tt) => <option key={tt} value={tt}>{tt}</option>)}
                  </select>
                  <button className="ghost xs" title="open in the inspector" onClick={() => onSelect({ kind: "node", id: n.id })}>⊙</button>
                  {n.anchor && checkAnchor(model.meta.extractedText, n.anchor) === "missing" && (
                    <span className="row-badge" title="anchor quote not found in the source text">⚠ anchor</span>
                  )}
                  {n.added && <span className="tag-added" title="you added this — not from the paper">＋</span>}
                  <button className="x" title="drop" onClick={() => update((m) => ops.dropNode(m, n.id))}>×</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ))}

      {/* Relations — kept ones; invalid ones stay visible, flagged, fixable. */}
      {model.edges.some((e) => !e.dropped) && (
        <div className="sec">
          <div className="sec-hd">
            Relations
            <span className="sec-count">{validation.liveEdgeCount}</span>
          </div>
          {model.edges.filter((e) => !e.dropped).map((e) => {
            const subj = model.nodes.find((n) => n.id === e.subject);
            const obj = model.nodes.find((n) => n.id === e.object);
            const valid = validation.edgeStatus.get(e.id)?.valid !== false;
            return (
              <div
                key={e.id}
                className={
                  (selection?.kind === "edge" && selection.id === e.id ? "row selected" : "row") + (valid ? "" : " dim")
                }
                onClick={() => onSelect({ kind: "edge", id: e.id })}
              >
                <span className="row-text">
                  <span className="row-rel">{e.relation}{valid ? "" : " ✕"} · </span>
                  {(subj?.text || e.subject).slice(0, 34)} → {(obj?.text || e.object).slice(0, 34)}
                </span>
                <button className="x" title="drop" onClick={(ev) => { ev.stopPropagation(); update((m) => ops.dropEdge(m, e.id)); }}>×</button>
              </div>
            );
          })}
        </div>
      )}

      <div className="stat-row">
        <div className="stat"><b>{validation.liveNodeCount}</b><span>nodes</span></div>
        <div className="stat"><b>{validation.liveEdgeCount}</b><span>relations</span></div>
        <div className="stat"><b>{anchored}/{validation.liveNodeCount}</b><span>anchors</span></div>
      </div>

      {model.meta.flakes.length > 0 && (
        <div className="banner warn">
          Partial draft — {model.meta.flakes.length} of {model.meta.pieces} pieces produced no usable
          graph; their content isn’t represented. Re-run to retry.
        </div>
      )}
      {model.meta.pieces > 1 && model.meta.flakes.length === 0 && (
        <div className="banner info">
          Whole paper read in {model.meta.pieces} pieces — {model.meta.folded} duplicate record(s)
          folded before staging, {model.meta.edgesAdded} cross-piece relation(s) added by the
          consolidation pass.
        </div>
      )}
      {model.meta.droppedNodes > 0 && (
        <div className="banner info">
          {model.meta.droppedNodes} malformed record(s) were dropped by the grammar check before
          this draft.
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
