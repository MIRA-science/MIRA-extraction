"use client";

import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  type Connection,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { StageNode, StageEdge, Validation } from "../lib/staging.ts";
import { NODE_STYLE } from "../lib/palette.ts";
import { layoutStage, type MiraNodeData } from "../lib/layout.ts";

export type Selection = { kind: "node" | "edge"; id: string } | null;

function MiraNode({ data, selected }: NodeProps<Node<MiraNodeData>>) {
  const style = NODE_STYLE[data.type as keyof typeof NODE_STYLE] ?? NODE_STYLE.claim;
  const border = data.needsText ? "#ef4444" : style.color;
  return (
    <div
      className="mira-node"
      style={{
        borderColor: border,
        boxShadow: selected ? `0 0 0 2px ${border}, 0 0 22px ${style.glow}` : `0 0 14px ${style.glow}`,
      }}
    >
      <Handle type="target" position={Position.Top} className="mira-handle" />
      <div className="mira-node-head">
        <span className="mira-node-dot" style={{ background: style.color }} />
        <span className="mira-node-type" style={{ color: style.color }}>
          {style.label}
        </span>
        {data.added && <span className="mira-node-added">＋</span>}
        <span className="mira-node-id">{data.nodeId}</span>
      </div>
      <div className="mira-node-text">{data.needsText ? <em className="muted">(empty — needs text)</em> : data.text}</div>
      <Handle type="source" position={Position.Bottom} className="mira-handle" />
    </div>
  );
}

const nodeTypes = { mira: MiraNode };

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
  const flow = useMemo(() => layoutStage(nodes, edges, validation), [nodes, edges, validation]);

  const styledNodes = useMemo(
    () => flow.nodes.map((n) => ({ ...n, selected: selection?.kind === "node" && selection.id === n.id })),
    [flow.nodes, selection],
  );
  const styledEdges = useMemo(
    () => flow.edges.map((e) => (selection?.kind === "edge" && selection.id === e.id ? { ...e, style: { ...e.style, strokeWidth: 3 } } : e)),
    [flow.edges, selection],
  );

  return (
    <ReactFlow
      nodes={styledNodes}
      edges={styledEdges}
      nodeTypes={nodeTypes}
      fitView
      minZoom={0.12}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      onNodeClick={(_, n) => onSelect({ kind: "node", id: n.id })}
      onEdgeClick={(_, e) => onSelect({ kind: "edge", id: e.id })}
      onPaneClick={() => onSelect(null)}
      onConnect={(c: Connection) => {
        if (c.source && c.target && c.source !== c.target) onConnect(c.source, c.target);
      }}
    >
      <Background color="#1e293b" gap={22} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
