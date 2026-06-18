import dagre from "@dagrejs/dagre";
import { MarkerType, type Edge as FlowEdge, type Node as FlowNode } from "@xyflow/react";
import type { StageNode, StageEdge, Validation } from "./staging.ts";
import { EDGE_COLOR } from "./palette.ts";

export const NODE_W = 240;
export const NODE_H = 88;

export interface MiraNodeData extends Record<string, unknown> {
  nodeId: string;
  type: string;
  text: string;
  needsText: boolean;
  added: boolean;
}

/**
 * Lay the (live) staging graph out top-down with dagre and translate it into React Flow
 * nodes/edges. Edges are ranked in their natural subject→object direction, so a node's
 * source handle (bottom) sits directly above its targets' target handle (top) — which makes
 * drag-to-connect line up cleanly. Invalid edges (per live validation) are drawn dashed-red;
 * dropped nodes/edges and edges with a missing endpoint are omitted (they live in the rail).
 */
export function layoutStage(
  nodes: StageNode[],
  edges: StageEdge[],
  v: Validation,
): { nodes: FlowNode<MiraNodeData>[]; edges: FlowEdge[] } {
  const live = nodes.filter((n) => !n.dropped);
  const ids = new Set(live.map((n) => n.id));
  const drawEdges = edges.filter((e) => !e.dropped && ids.has(e.subject) && ids.has(e.object));

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: 55, ranksep: 95, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of live) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of drawEdges) g.setEdge(e.subject, e.object);
  dagre.layout(g);

  const flowNodes: FlowNode<MiraNodeData>[] = live.map((n) => {
    const p = g.node(n.id);
    return {
      id: n.id,
      type: "mira",
      position: { x: (p?.x ?? 0) - NODE_W / 2, y: (p?.y ?? 0) - NODE_H / 2 },
      data: {
        nodeId: n.id,
        type: n.type,
        text: n.text,
        needsText: !n.text.trim(),
        added: !!n.added,
      },
    };
  });

  const flowEdges: FlowEdge[] = drawEdges.map((e) => {
    const valid = v.edgeStatus.get(e.id)?.valid !== false;
    const color = valid ? EDGE_COLOR[e.relation] ?? "#64748b" : "#ef4444";
    return {
      id: e.id,
      source: e.subject,
      target: e.object,
      label: valid ? e.relation : `${e.relation} ✕`,
      labelStyle: { fill: color, fontWeight: 600, fontSize: 11 },
      labelBgStyle: { fill: "#0b1120", fillOpacity: 0.85 },
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
      animated: valid && (e.relation === "supports" || e.relation === "opposes"),
      style: { stroke: color, strokeWidth: 1.6, strokeDasharray: valid ? undefined : "5 4" },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
    };
  });

  return { nodes: flowNodes, edges: flowEdges };
}
