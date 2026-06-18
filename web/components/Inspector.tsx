"use client";

import { checkAnchor, type AnchorMatch } from "../lib/types.ts";
import {
  ops,
  legalRelationsForPair,
  NODE_TYPES,
  EPISTEMIC_STATUSES,
  SOURCE_TYPES,
  EDGE_GRAMMAR,
  type StageModel,
  type StageNode,
  type Validation,
} from "../lib/staging.ts";
import { NODE_STYLE, EDGE_COLOR } from "../lib/palette.ts";
import type { Selection } from "./GraphView.tsx";

type Update = (fn: (m: StageModel) => StageModel) => void;

function AnchorEditor({ anchor, text, onChange }: { anchor: string; text: string; onChange: (v: string) => void }) {
  const match = anchor.trim() ? checkAnchor(text, anchor.trim()) : null;
  const badge: Record<AnchorMatch, { label: string; cls: string }> = {
    exact: { label: "✓ found verbatim in source", cls: "ok" },
    normalized: { label: "≈ found (whitespace/case differs)", cls: "warn" },
    missing: { label: "⚠ not found in source — edit to match the paper", cls: "bad" },
  };
  const b = match ? badge[match] : null;
  return (
    <>
      <textarea
        className="textarea anchor-input"
        placeholder="Verbatim quote from the paper that grounds this record…"
        value={anchor}
        onChange={(e) => onChange(e.target.value)}
      />
      {b ? <span className={`anchor-badge ${b.cls}`}>{b.label}</span> : <span className="muted tiny">No anchor — paste a short quote to ground it.</span>}
    </>
  );
}

function NodeEditor({ node, model, validation, update, onSelect }: { node: StageNode; model: StageModel; validation: Validation; update: Update; onSelect: (s: Selection) => void }) {
  const style = NODE_STYLE[node.type];
  const label = (id: string) => model.nodes.find((n) => n.id === id);
  const incident = model.edges.filter((e) => !e.dropped && (e.subject === node.id || e.object === node.id));
  const set = (patch: Partial<StageNode>) => update((m) => ops.editNode(m, node.id, patch));

  return (
    <>
      <div className="insp-head">
        <span className="chip" style={{ background: style.glow, color: style.color, borderColor: style.color }}>{style.label}</span>
        <span className="insp-id">{node.id}</span>
        {node.added && <span className="tag-added">＋ added</span>}
        {node.dropped && <span className="tag-dropped">dropped</span>}
      </div>

      <label className="field">
        <span>Text {validation.nodeNeedsText.has(node.id) && <em className="req">required</em>}</span>
        <textarea className="textarea short" value={node.text} onChange={(e) => set({ text: e.target.value })} />
      </label>

      <label className="field">
        <span>Type</span>
        <select value={node.type} onChange={(e) => set({ type: e.target.value as StageNode["type"] })}>
          {NODE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </label>

      {node.type === "claim" && (
        <label className="field">
          <span>Epistemic status</span>
          <select value={node.epistemicStatus ?? "claim"} onChange={(e) => set({ epistemicStatus: e.target.value })}>
            {EPISTEMIC_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
      )}

      {node.type === "source" && (
        <>
          <label className="field">
            <span>Source type</span>
            <select value={node.sourceType ?? ""} onChange={(e) => set({ sourceType: e.target.value || undefined })}>
              <option value="">(unset)</option>
              {SOURCE_TYPES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="field">
            <span>DOI</span>
            <input value={node.doi ?? ""} onChange={(e) => set({ doi: e.target.value || undefined })} placeholder="10.xxxx/…" />
          </label>
          <label className="field">
            <span>URL</span>
            <input value={node.url ?? ""} onChange={(e) => set({ url: e.target.value || undefined })} placeholder="https://…" />
          </label>
        </>
      )}

      <label className="field">
        <span>Description</span>
        <textarea className="textarea short" value={node.description ?? ""} onChange={(e) => set({ description: e.target.value || undefined })} placeholder="Fuller context/reasoning (optional)…" />
      </label>

      <h4>Anchor</h4>
      <AnchorEditor anchor={node.anchor ?? ""} text={model.meta.extractedText} onChange={(v) => set({ anchor: v || undefined })} />

      {incident.length > 0 && (
        <>
          <h4>Relations</h4>
          <ul className="rel-list">
            {incident.map((e) => {
              const valid = validation.edgeStatus.get(e.id)?.valid !== false;
              const other = e.subject === node.id ? label(e.object) : label(e.subject);
              const dir = e.subject === node.id ? "→" : "←";
              return (
                <li key={e.id} className="rel-row">
                  <button className="rel-link" onClick={() => onSelect({ kind: "edge", id: e.id })}>
                    <b style={{ color: valid ? EDGE_COLOR[e.relation] : "#ef4444" }}>{e.relation}{valid ? "" : " ✕"}</b> {dir}{" "}
                    <span className="muted">{(other?.text || other?.id) ?? "?"}</span>
                  </button>
                  <button className="x" title="drop relation" onClick={() => update((m) => ops.dropEdge(m, e.id))}>×</button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className="insp-actions">
        {node.dropped ? (
          <button className="ghost" onClick={() => update((m) => ops.restoreNode(m, node.id))}>↩ Restore node</button>
        ) : (
          <button className="danger" onClick={() => update((m) => ops.dropNode(m, node.id))}>⌫ Drop node</button>
        )}
      </div>
    </>
  );
}

function EdgeEditor({ edgeId, model, validation, update, onSelect }: { edgeId: string; model: StageModel; validation: Validation; update: Update; onSelect: (s: Selection) => void }) {
  const edge = model.edges.find((e) => e.id === edgeId);
  if (!edge) return <p className="muted">Relation not found.</p>;
  const live = model.nodes.filter((n) => !n.dropped);
  const subj = model.nodes.find((n) => n.id === edge.subject);
  const obj = model.nodes.find((n) => n.id === edge.object);
  const status = validation.edgeStatus.get(edge.id);
  const valid = status?.valid !== false;
  const color = valid ? EDGE_COLOR[edge.relation] ?? "#64748b" : "#ef4444";

  // relation choices legal for the current endpoint types, plus the current value if illegal
  const legal = subj && obj ? legalRelationsForPair(subj.type, obj.type) : [];
  const choices = legal.includes(edge.relation) ? legal : [edge.relation, ...legal];

  const opt = (n: StageNode) => <option key={n.id} value={n.id}>{`${n.type}: ${(n.text || n.id).slice(0, 48)}`}</option>;

  return (
    <>
      <div className="insp-head">
        <span className="chip" style={{ background: "transparent", color, borderColor: color }}>{edge.relation}{valid ? "" : " ✕"}</span>
        <span className="insp-id">{edge.id}</span>
        {edge.added && <span className="tag-added">＋ added</span>}
      </div>
      {!valid && status?.reason && <p className="anchor-badge bad">{status.reason}</p>}

      <label className="field">
        <span>Subject</span>
        <select value={edge.subject} onChange={(e) => update((m) => ops.editEdge(m, edge.id, { subject: e.target.value }))}>{live.map(opt)}</select>
      </label>

      <label className="field">
        <span>Relation</span>
        <select value={edge.relation} onChange={(e) => update((m) => ops.editEdge(m, edge.id, { relation: e.target.value }))}>
          {choices.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        {subj && obj && legal.length === 0 && <em className="muted tiny">No legal relation for {subj.type}→{obj.type}. Re-point an endpoint.</em>}
      </label>

      <label className="field">
        <span>Object</span>
        <select value={edge.object} onChange={(e) => update((m) => ops.editEdge(m, edge.id, { object: e.target.value }))}>{live.map(opt)}</select>
      </label>

      <p className="muted tiny">Legal: {Object.entries(EDGE_GRAMMAR).map(([r, g]) => `${r} (${g.subj.join("|")}→${g.obj.join("|")})`).join(" · ")}</p>

      <h4>Anchor</h4>
      <AnchorEditor anchor={edge.anchor ?? ""} text={model.meta.extractedText} onChange={(v) => update((m) => ops.editEdge(m, edge.id, { anchor: v || undefined }))} />

      <div className="insp-actions">
        {edge.dropped ? (
          <button className="ghost" onClick={() => update((m) => ops.restoreEdge(m, edge.id))}>↩ Restore relation</button>
        ) : (
          <button className="danger" onClick={() => update((m) => ops.dropEdge(m, edge.id))}>⌫ Drop relation</button>
        )}
      </div>
    </>
  );
}

export default function Inspector({
  selection,
  model,
  validation,
  update,
  onSelect,
}: {
  selection: Selection;
  model: StageModel;
  validation: Validation;
  update: Update;
  onSelect: (s: Selection) => void;
}) {
  if (!selection) {
    return (
      <div className="inspector empty">
        <p className="muted">Click a node or relation to edit it. Drag from a node's bottom dot to another node's top to draw a new relation.</p>
      </div>
    );
  }
  const node = selection.kind === "node" ? model.nodes.find((n) => n.id === selection.id) : undefined;
  return (
    <div className="inspector">
      <button className="insp-close" onClick={() => onSelect(null)} aria-label="Close">✕</button>
      {selection.kind === "node"
        ? node
          ? <NodeEditor node={node} model={model} validation={validation} update={update} onSelect={onSelect} />
          : <p className="muted">Node not found.</p>
        : <EdgeEditor edgeId={selection.id} model={model} validation={validation} update={update} onSelect={onSelect} />}
    </div>
  );
}
