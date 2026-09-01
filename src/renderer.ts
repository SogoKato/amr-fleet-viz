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
    const xs = config.nodes.map((n) => n.x);
    const ys = config.nodes.map((n) => n.y);
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
    this.drawNodes(config, v, highlight?.nodeId ?? null);
    for (const state of states) this.drawRobot(state, v, proximity.has(state));
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
      // Distance label; a "*" marks an explicit override of the drawn length.
      const label = `${edge.distance.toFixed(1)}m${edge.explicit ? "*" : ""}`;
      ctx.fillStyle = isSelected ? "#79b8ff" : "rgba(255, 255, 255, 0.35)";
      ctx.fillText(label, (x1 + x2) / 2, (y1 + y2) / 2 - 8);
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

    // Phase badge for stationary phases
    if (state.phase === "waiting" || state.phase === "idle" || state.phase === "turning") {
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(255, 255, 255, 0.9)";
      const badge = state.phase === "turning" ? "↻" : state.phase === "waiting" ? "⏸" : "…";
      ctx.fillText(badge, x + r + 8, y - r);
    }

    ctx.font = "bold 12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = "#f3f4f6";
    ctx.fillText(state.robot.id, x, y - r - 4);
  }
}
