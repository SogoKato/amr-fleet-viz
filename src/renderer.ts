import type { RobotState } from "./simulation";
import type { ResolvedConfig } from "./types";

const ROBOT_RADIUS_M = 0.28;
const NODE_RADIUS_PX = 6;

interface Viewport {
  scale: number; // pixels per meter
  offsetX: number;
  offsetY: number;
  height: number;
}

/** What the map editor wants emphasized on the canvas. */
export interface Highlight {
  nodeId: string | null;
  edge: { from: string; to: string } | null;
  /** Route of the robot selected in the editor, drawn as a colored overlay. */
  route: { color: string; loop: boolean; stops: { x: number; y: number }[] } | null;
}

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private lastViewport: Viewport | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas is not supported");
    this.ctx = ctx;
  }

  /** Map coordinates (meters) → canvas CSS pixels, using the last drawn frame. */
  mapToPx(x: number, y: number): [number, number] | null {
    return this.lastViewport ? this.toPx(this.lastViewport, x, y) : null;
  }

  /** Canvas CSS pixels → map coordinates (meters), using the last drawn frame. */
  pxToMap(px: number, py: number): [number, number] | null {
    const v = this.lastViewport;
    if (!v) return null;
    return [(px - v.offsetX) / v.scale, (v.height - py - v.offsetY) / v.scale];
  }

  /** Match the canvas backing store to its CSS size and device pixel ratio. */
  private syncSize(): { width: number; height: number } {
    const dpr = window.devicePixelRatio || 1;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (this.canvas.width !== width * dpr || this.canvas.height !== height * dpr) {
      this.canvas.width = width * dpr;
      this.canvas.height = height * dpr;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { width, height };
  }

  private viewport(config: ResolvedConfig, width: number, height: number): Viewport {
    // An empty map still needs a sensible viewport to draw the grid
    // and place double-clicked nodes into.
    const xs = config.nodes.length > 0 ? config.nodes.map((n) => n.x) : [-5, 5];
    const ys = config.nodes.length > 0 ? config.nodes.map((n) => n.y) : [-4, 4];
    const minX = Math.min(...xs) - 1;
    const maxX = Math.max(...xs) + 1;
    const minY = Math.min(...ys) - 1;
    const maxY = Math.max(...ys) + 1;
    const scale = Math.min(width / (maxX - minX), height / (maxY - minY));
    return {
      scale,
      offsetX: (width - (maxX - minX) * scale) / 2 - minX * scale,
      offsetY: (height - (maxY - minY) * scale) / 2 - minY * scale,
      height,
    };
  }

  /** Map coordinates (meters, y up) → canvas pixels (y down). */
  private toPx(v: Viewport, x: number, y: number): [number, number] {
    return [v.offsetX + x * v.scale, v.height - (v.offsetY + y * v.scale)];
  }

  draw(config: ResolvedConfig, states: RobotState[], proximity: Set<RobotState>, highlight?: Highlight | null): void {
    const { width, height } = this.syncSize();
    const v = this.viewport(config, width, height);
    this.lastViewport = v;
    const ctx = this.ctx;

    ctx.fillStyle = "#101418";
    ctx.fillRect(0, 0, width, height);
    this.drawGrid(v, width, height);
    this.drawEdges(config, v, highlight?.edge ?? null);
    if (highlight?.route) this.drawRoute(highlight.route, v);
    this.drawNodes(config, v, highlight?.nodeId ?? null);
    for (const state of states) {
      if (state.placed) this.drawRobot(state, v, proximity.has(state));
    }
  }

  /** Overlay for the robot selected in the editor: its path plus stop order numbers. */
  private drawRoute(route: NonNullable<Highlight["route"]>, v: Viewport): void {
    const ctx = this.ctx;
    const stops = route.stops;
    if (stops.length === 0) return;
    if (stops.length >= 2) {
      ctx.save();
      ctx.strokeStyle = route.color;
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = 5;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      const [x0, y0] = this.toPx(v, stops[0].x, stops[0].y);
      ctx.moveTo(x0, y0);
      for (let i = 1; i < stops.length; i++) {
        const [x, y] = this.toPx(v, stops[i].x, stops[i].y);
        ctx.lineTo(x, y);
      }
      const last = stops[stops.length - 1];
      if (route.loop && (last.x !== stops[0].x || last.y !== stops[0].y)) ctx.closePath();
      ctx.stroke();
      ctx.restore();
    }
    // Visit order, grouped per node (a node can appear multiple times).
    const orders = new Map<string, { x: number; y: number; indices: number[] }>();
    stops.forEach((s, i) => {
      const key = `${s.x},${s.y}`;
      const entry = orders.get(key) ?? { x: s.x, y: s.y, indices: [] };
      entry.indices.push(i + 1);
      orders.set(key, entry);
    });
    ctx.font = "bold 11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillStyle = route.color;
    for (const { x, y, indices } of orders.values()) {
      const [px, py] = this.toPx(v, x, y);
      ctx.fillText(indices.join("·"), px, py + NODE_RADIUS_PX + 4);
    }
  }

  private drawGrid(v: Viewport, width: number, height: number): void {
    const ctx = this.ctx;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
    ctx.lineWidth = 1;
    const step = v.scale; // 1 meter
    if (step < 8) return;
    const [originX, originY] = this.toPx(v, 0, 0);
    ctx.beginPath();
    for (let x = originX % step; x < width; x += step) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
    }
    for (let y = originY % step; y < height; y += step) {
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
    }
    ctx.stroke();
  }

  private drawEdges(config: ResolvedConfig, v: Viewport, selected: { from: string; to: string } | null): void {
    const ctx = this.ctx;
    ctx.font = "11px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const edge of config.edges) {
      const isSelected =
        selected !== null &&
        ((edge.from.id === selected.from && edge.to.id === selected.to) ||
          (edge.from.id === selected.to && edge.to.id === selected.from));
      const [x1, y1] = this.toPx(v, edge.from.x, edge.from.y);
      const [x2, y2] = this.toPx(v, edge.to.x, edge.to.y);
      ctx.strokeStyle = isSelected ? "#388bfd" : "rgba(255, 255, 255, 0.18)";
      ctx.lineWidth = isSelected ? 3 : 2;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      // Distance label; a "*" marks an explicit override of the drawn length,
      // shown in amber because it does not follow node moves.
      const label = `${edge.distance.toFixed(1)}m${edge.explicit ? "*" : ""}`;
      ctx.fillStyle = isSelected ? "#79b8ff" : edge.explicit ? "#e3b341" : "rgba(255, 255, 255, 0.35)";
      ctx.fillText(label, (x1 + x2) / 2, (y1 + y2) / 2 - 8);
    }
    if (config.edges.some((e) => e.explicit)) {
      ctx.fillStyle = "#e3b341";
      ctx.textAlign = "left";
      ctx.fillText("* fixed distance override (ignores drawn length)", 10, v.height - 12);
      ctx.textAlign = "center";
    }
  }

  private drawNodes(config: ResolvedConfig, v: Viewport, selectedId: string | null): void {
    const ctx = this.ctx;
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    for (const node of config.nodes) {
      const [x, y] = this.toPx(v, node.x, node.y);
      ctx.fillStyle = "#4b5563";
      ctx.beginPath();
      ctx.arc(x, y, NODE_RADIUS_PX, 0, 2 * Math.PI);
      ctx.fill();
      ctx.strokeStyle = "#9ca3af";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (node.id === selectedId) {
        ctx.strokeStyle = "#388bfd";
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.arc(x, y, NODE_RADIUS_PX + 5, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.fillStyle = "#d1d5db";
      ctx.fillText(node.label, x, y - NODE_RADIUS_PX - 4);
    }
  }

  private drawRobot(state: RobotState, v: Viewport, nearOther: boolean): void {
    const ctx = this.ctx;
    const [x, y] = this.toPx(v, state.x, state.y);
    const r = Math.max(ROBOT_RADIUS_M * v.scale, 8);
    // Canvas y is flipped, so headings are negated when drawn.
    const heading = -state.heading;

    if (nearOther) {
      ctx.strokeStyle = "#ff2d2d";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, r + 5, 0, 2 * Math.PI);
      ctx.stroke();
    }

    ctx.fillStyle = state.robot.color;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, 2 * Math.PI);
    ctx.fill();

    // Heading pointer
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(heading) * r * 0.9, y + Math.sin(heading) * r * 0.9);
    ctx.stroke();

    // Phase badge for stationary phases (drawn, not text — headless
    // environments often lack emoji glyphs).
    const bx = x + r + 8;
    const by = y - r;
    ctx.strokeStyle = ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
    if (state.phase === "waiting") {
      ctx.fillRect(bx - 3.5, by - 4, 2.5, 8);
      ctx.fillRect(bx + 1, by - 4, 2.5, 8);
    } else if (state.phase === "turning") {
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(bx, by, 4, -0.5 * Math.PI, Math.PI);
      ctx.stroke();
      ctx.beginPath(); // arrowhead at the arc's start (top)
      ctx.moveTo(bx + 1, by - 6.5);
      ctx.lineTo(bx + 4.5, by - 4);
      ctx.lineTo(bx - 0.5, by - 1.5);
      ctx.closePath();
      ctx.fill();
    } else if (state.phase === "idle") {
      for (const dx of [-4, 0, 4]) {
        ctx.beginPath();
        ctx.arc(bx + dx, by, 1.3, 0, 2 * Math.PI);
        ctx.fill();
      }
    }

    ctx.font = "bold 12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = "#f3f4f6";
    ctx.fillText(state.robot.id, x, y - r - 4);
  }
}
