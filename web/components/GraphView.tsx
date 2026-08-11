"use client";

import { useMemo, useState } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Panel,
  Position,
  type Connection,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { StageNode, StageEdge, Validation } from "../lib/staging.ts";
import { EDGE_GRAMMAR } from "../lib/staging.ts";
import { NODE_ORDER, NODE_STYLE, EDGE_COLOR } from "../lib/palette.ts";
import { computePositions, drawableEdges, layoutStage, structureKey, type MiraNodeData } from "../lib/layout.ts";

export type Selection = { kind: "node" | "edge"; id: string } | null;

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** A record in the viewer's language: a glowing type-colored dot, its label
 *  beneath — drawn only when zoomed in (the viewer's showDotLabels rule) or
 *  lit by hover/selection. */
function MiraNode({ data, selected }: NodeProps<Node<MiraNodeData>>) {
  const style = NODE_STYLE[data.type as keyof typeof NODE_STYLE] ?? NODE_STYLE.Claim;
  return (
    <div
      className={selected ? "mira-node selected" : "mira-node"}
      style={{ color: style.color, width: data.size, height: data.size }}
    >
      <Handle type="target" position={Position.Top} className="mira-handle" />
      <div className="mira-dot" style={{ background: data.needsText ? "#e76a5b" : style.color }} />
      <div className="mira-label">
        {data.needsText ? <em>(empty)</em> : truncate(data.text, 26)}
        {data.added ? " ＋" : ""}
      </div>
      <Handle type="source" position={Position.Bottom} className="mira-handle" />
    </div>
  );
}

const nodeTypes = { mira: MiraNode };

/** The viewer's bottom-left legend: nodes and relations, color-decoded. */
function Legend() {
  return (
    <Panel position="bottom-left" className="canvas-legend">
      <div className="cl-row">
        <span className="cl-k">nodes</span>
        {NODE_ORDER.map((t) => (
          <span key={t} className="cl-item">
            <span className="cl-dot" style={{ background: NODE_STYLE[t].color, color: NODE_STYLE[t].color }} />
            {NODE_STYLE[t].label.toLowerCase()}
          </span>
        ))}
      </div>
      <div className="cl-row">
        <span className="cl-k">relations</span>
        {Object.keys(EDGE_GRAMMAR).map((r) => (
          <span key={r} className="cl-item">
            <span className="cl-dash" style={{ background: EDGE_COLOR[r] }} />
            {r}
          </span>
        ))}
      </div>
    </Panel>
  );
}

export default function GraphView({
  nodes,
  edges,
  validation,
  selection,
  onSelect,
  onConnect,
}: {
  nodes: StageNode[];
  edges: StageEdge[];
  validation: Validation;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onConnect: (subject: string, object: string) => void;
}) {
  // the viewer's declutter rule: dot labels only when zoomed in (k >= 0.6)
  const [zoomedIn, setZoomedIn] = useState(true);

  // positions depend only on the drawable STRUCTURE — text edits never relayout
  const structKey = structureKey(nodes, edges, validation);
  const positions = useMemo(() => {
    const live = nodes.filter((n) => !n.dropped).map((n) => n.id);
    const springs = drawableEdges(nodes, edges, validation).map(
      (e) => [e.subject, e.object] as [string, string],
    );
    return computePositions(live, springs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structKey]);

  const flow = useMemo(
    () => layoutStage(nodes, edges, validation, positions),
    [nodes, edges, validation, positions],
  );

  const styledNodes = useMemo(
    () => flow.nodes.map((n) => ({ ...n, selected: selection?.kind === "node" && selection.id === n.id })),
    [flow.nodes, selection],
  );
  const styledEdges = useMemo(
    () =>
      flow.edges.map((e) =>
        selection?.kind === "edge" && selection.id === e.id
          ? { ...e, style: { ...e.style, strokeWidth: 2.6, opacity: 1 } }
          : e,
      ),
    [flow.edges, selection],
  );

  return (
    <div className={zoomedIn ? "canvas-flow show-labels" : "canvas-flow"}>
      <ReactFlow
        nodes={styledNodes}
        edges={styledEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.1}
        maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
        onMove={(_, vp) => setZoomedIn(vp.zoom >= 0.6)}
        onNodeClick={(_, n) => onSelect({ kind: "node", id: n.id })}
        onEdgeClick={(_, e) => onSelect({ kind: "edge", id: e.id })}
        onPaneClick={() => onSelect(null)}
        onConnect={(c: Connection) => {
          if (c.source && c.target && c.source !== c.target) onConnect(c.source, c.target);
        }}
      >
        <Background variant={BackgroundVariant.Lines} gap={44} color="rgba(130,155,165,0.045)" />
        <Controls showInteractive={false} />
        <Legend />
      </ReactFlow>
    </div>
  );
}
