/**
 * Graph layout — RRGI's OWN physics, ported from the viewer's core.js tick()
 * (read, not reconstructed; constants verbatim):
 *
 *   - deterministic golden-angle spiral seeding (SEED_SPACING 40)
 *   - all-pairs repulsion rep=3600 (2600 past 400 nodes), floor REP_MIN_D2=100
 *   - springs: rest length 150, strength 0.06 (f = (d-rest)/d * 0.06 * alpha)
 *   - center gravity 0.0016; SATELLITES: the largest connected component keeps
 *     the center, every minor component of ≥2 nodes anchors on a ring hugging
 *     the main blob's rim (golden-angle spread, satR = 80+60√size, SAT_PAD 220,
 *     gravity 0.004) — disconnected clusters settle as distinct islands
 *   - velocity damping 0.86, centroid tether, alpha 1 → ×0.985 per tick, stop
 *     at 0.004 (≈350 ticks, run synchronously here)
 *
 * Node radius (viewer's buildStaging): base 13 for a Claim, 9 otherwise,
 * + min(degree, 8) × 1.5. Invalid edges are NOT drawn — exactly like the
 * viewer's staging graph, they live in the rail until fixed. Edge color IS the
 * relation (no labels; the legend decodes).
 */
import { MarkerType, type Edge as FlowEdge, type Node as FlowNode } from "@xyflow/react";
import type { StageNode, StageEdge, Validation } from "./staging.ts";
import { EDGE_COLOR } from "./palette.ts";

export interface MiraNodeData extends Record<string, unknown> {
  nodeId: string;
  type: string;
  text: string;
  needsText: boolean;
  added: boolean;
  /** dot diameter in px (2r) — the viewer's degree-based sizing */
  size: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const SEED_SPACING = 40;
const REP_MIN_D2 = 100;
const SAT_PAD = 220;
const CX = 800; // virtual field center — React Flow's fitView frames the result
const CY = 500;

/** The drawable springs: kept + VALID edges between live nodes (the viewer's
 *  buildStaging draws exactly these). */
export function drawableEdges(nodes: StageNode[], edges: StageEdge[], v: Validation): StageEdge[] {
  const ids = new Set(nodes.filter((n) => !n.dropped).map((n) => n.id));
  return edges.filter(
    (e) => !e.dropped && v.edgeStatus.get(e.id)?.valid !== false && ids.has(e.subject) && ids.has(e.object),
  );
}

/** A stable signature of the drawable STRUCTURE — positions recompute only
 *  when this changes, never on text edits. */
export function structureKey(nodes: StageNode[], edges: StageEdge[], v: Validation): string {
  const ids = nodes.filter((n) => !n.dropped).map((n) => n.id);
  const pairs = drawableEdges(nodes, edges, v).map((e) => `${e.subject}>${e.object}`);
  return ids.join(",") + "|" + pairs.join(",");
}

/** Run the viewer's simulation to rest. Returns id → {x, y} (dot centers). */
export function computePositions(ids: string[], springs: [string, string][]): Map<string, { x: number; y: number }> {
  const n = ids.length;
  if (!n) return new Map();
  const idx = new Map(ids.map((id, i) => [id, i]));

  // golden-angle spiral seed (deterministic — same graph, same layout)
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = SEED_SPACING * Math.sqrt(0.5 + i);
    const a = i * GOLDEN_ANGLE;
    x[i] = CX + r * Math.cos(a);
    y[i] = CY + r * Math.sin(a);
  }
  const E: [number, number][] = [];
  for (const [s, o] of springs) {
    const a = idx.get(s);
    const b = idx.get(o);
    if (a != null && b != null && a !== b) E.push([a, b]);
  }

  // connected components → satellite anchors (viewer's labelComponents)
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  for (const [a, b] of E) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  const compSize = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    compSize.set(r, (compSize.get(r) ?? 0) + 1);
  }
  let mainRoot = -1;
  let mainSize = -1;
  for (const [r, size] of compSize) if (size > mainSize) { mainSize = size; mainRoot = r; }
  // minor components of ≥2 nodes become satellites; singletons keep the center
  const satOf = new Int32Array(n).fill(-1);
  const satellites: { angle: number; satR: number }[] = [];
  const satIndex = new Map<number, number>();
  let k = 0;
  for (const [r, size] of compSize) {
    if (r === mainRoot || size < 2) continue;
    satIndex.set(r, satellites.length);
    satellites.push({ angle: k * GOLDEN_ANGLE, satR: 80 + 60 * Math.sqrt(size) });
    k++;
  }
  for (let i = 0; i < n; i++) {
    const s = satIndex.get(find(i));
    if (s != null) satOf[i] = s;
  }

  // the viewer's tick(), run to rest
  const rep = n > 400 ? 2600 : 3600;
  let alpha = 1;
  while (alpha >= 0.004) {
    // all-pairs repulsion
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = x[i] - x[j];
        let dy = y[i] - y[j];
        let d2 = dx * dx + dy * dy;
        if (d2 < REP_MIN_D2) d2 = REP_MIN_D2;
        const f = (rep / d2) * alpha;
        const d = Math.sqrt(d2);
        const ux = dx / d;
        const uy = dy / d;
        vx[i] += ux * f; vy[i] += uy * f;
        vx[j] -= ux * f; vy[j] -= uy * f;
      }
    }
    // springs
    for (const [a, b] of E) {
      const dx = x[b] - x[a];
      const dy = y[b] - y[a];
      const d = Math.hypot(dx, dy) || 0.01;
      const f = ((d - 150) / d) * 0.06 * alpha;
      vx[a] += dx * f; vy[a] += dy * f;
      vx[b] -= dx * f; vy[b] -= dy * f;
    }
    // main-blob rim estimate (rms·√2), for satellite ring anchors
    let ringR = 0;
    if (satellites.length) {
      let s2 = 0;
      let c2 = 0;
      for (let i = 0; i < n; i++) {
        if (satOf[i] === -1) { const ex = x[i] - CX; const ey = y[i] - CY; s2 += ex * ex + ey * ey; c2++; }
      }
      ringR = c2 ? Math.sqrt(s2 / c2) * 1.414 : 0;
    }
    // gravity (center, or the satellite's ring slot), damping, integrate
    for (let i = 0; i < n; i++) {
      let tx = CX;
      let ty = CY;
      let g = 0.0016;
      if (satOf[i] >= 0) {
        const s = satellites[satOf[i]];
        const r = ringR + SAT_PAD + s.satR;
        tx = CX + Math.cos(s.angle) * r;
        ty = CY + Math.sin(s.angle) * r;
        g = 0.004;
      }
      vx[i] += (tx - x[i]) * g * alpha;
      vy[i] += (ty - y[i]) * g * alpha;
      vx[i] *= 0.86; vy[i] *= 0.86;
      x[i] += vx[i]; y[i] += vy[i];
    }
    // centroid tether — net drift impossible
    let mx = 0;
    let my = 0;
    for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
    const sx = mx / n - CX;
    const sy = my / n - CY;
    for (let i = 0; i < n; i++) { x[i] -= sx; y[i] -= sy; }
    alpha *= 0.985;
  }
  return new Map(ids.map((id, i) => [id, { x: x[i], y: y[i] }]));
}

/** Decorate the live graph into React Flow nodes/edges at the given positions
 *  (dot centers → top-left, sized by degree exactly like the viewer). */
export function layoutStage(
  nodes: StageNode[],
  edges: StageEdge[],
  v: Validation,
  positions: Map<string, { x: number; y: number }>,
): { nodes: FlowNode<MiraNodeData>[]; edges: FlowEdge[] } {
  const live = nodes.filter((n) => !n.dropped);
  const draw = drawableEdges(nodes, edges, v);

  const degree = new Map<string, number>();
  for (const e of draw) {
    degree.set(e.subject, (degree.get(e.subject) ?? 0) + 1);
    degree.set(e.object, (degree.get(e.object) ?? 0) + 1);
  }

  const flowNodes: FlowNode<MiraNodeData>[] = live.map((n) => {
    const p = positions.get(n.id) ?? { x: CX, y: CY };
    const base = n.type === "Claim" ? 13 : 9;
    const r = base + Math.min(degree.get(n.id) ?? 0, 8) * 1.5;
    return {
      id: n.id,
      type: "mira",
      position: { x: p.x - r, y: p.y - r },
      data: { nodeId: n.id, type: n.type, text: n.text, needsText: !n.text.trim(), added: !!n.added, size: r * 2 },
    };
  });

  const flowEdges: FlowEdge[] = draw.map((e) => {
    const color = EDGE_COLOR[e.relation] ?? "#818d93";
    return {
      id: e.id,
      source: e.subject,
      target: e.object,
      type: "straight",
      style: { stroke: color, strokeWidth: 1.4, opacity: 0.8 },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 11, height: 11 },
    };
  });

  return { nodes: flowNodes, edges: flowEdges };
}
