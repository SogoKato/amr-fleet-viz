import { edgeKey, euclidean } from "./config";
import type { Highlight, Renderer } from "./renderer";
import type { EdgeConfig, FleetConfig, MapNode, NodeConfig, ResolvedConfig, RouteStop } from "./types";

const NODE_HIT_RADIUS_PX = 12;
const EDGE_HIT_RADIUS_PX = 7;

/** Everything the editor needs from the host application. */
export interface EditorHost {
  /** Raw (serializable) config currently loaded; null when nothing is loaded. */
  getRaw(): FleetConfig | null;
  /** Resolved config of the running simulation, for hit testing. */
  getResolved(): ResolvedConfig | null;
  /** Re-validate the mutated raw config and rebuild the simulation. Returns false (and reverts) on failure. */
  applyChanges(): boolean;
  showMessage(message: string): void;
}

/**
 * In-app map editor: grid-snapped node placement/dragging, edge creation
 * with explicit distances, all mutating the same raw config that
 * "Save config" exports.
 */
export class MapEditor {
  enabled = false;
  private snap = 0.5;
  private selectedNodeId: string | null = null;
  private selectedEdge: { from: string; to: string } | null = null;
  private dragging: {
    id: string;
    moved: boolean;
    /** Arc constraint from a fixed-distance edge: swing around anchor, keep the drawn length. */
    arc: { anchorId: string; radius: number } | null;
  } | null = null;

  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: Renderer;
  private readonly panel: HTMLElement;
  private readonly host: EditorHost;

  constructor(canvas: HTMLCanvasElement, renderer: Renderer, panel: HTMLElement, host: EditorHost) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.panel = panel;
    this.host = host;

    canvas.addEventListener("mousedown", (e) => this.onMouseDown(e));
    window.addEventListener("mousemove", (e) => this.onMouseMove(e));
    window.addEventListener("mouseup", () => (this.dragging = null));
    canvas.addEventListener("dblclick", (e) => this.onDoubleClick(e));
    window.addEventListener("keydown", (e) => this.onKeyDown(e));
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.selectedNodeId = null;
    this.selectedEdge = null;
    this.dragging = null;
    this.panel.style.display = on ? "block" : "none";
    document.body.classList.toggle("editing", on);
    this.renderPanel();
  }

  /** Called by the host after a new config is loaded. */
  reset(): void {
    this.selectedNodeId = null;
    this.selectedEdge = null;
    this.dragging = null;
    this.renderPanel();
  }

  highlight(): Highlight | null {
    if (!this.enabled) return null;
    return { nodeId: this.selectedNodeId, edge: this.selectedEdge };
  }

  /* ---- geometry helpers ---- */

  private snapValue(v: number): number {
    if (this.snap <= 0) return round2(v);
    return Math.round(v / this.snap) * this.snap;
  }

  private canvasPoint(e: MouseEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  private nodeAt(px: number, py: number): MapNode | null {
    const resolved = this.host.getResolved();
    if (!resolved) return null;
    for (const node of resolved.nodes) {
      const p = this.renderer.mapToPx(node.x, node.y);
      if (p && Math.hypot(p[0] - px, p[1] - py) <= NODE_HIT_RADIUS_PX) return node;
    }
    return null;
  }

  private edgeAt(px: number, py: number): { from: string; to: string } | null {
    const resolved = this.host.getResolved();
    if (!resolved) return null;
    for (const edge of resolved.edges) {
      const a = this.renderer.mapToPx(edge.from.x, edge.from.y);
      const b = this.renderer.mapToPx(edge.to.x, edge.to.y);
      if (!a || !b) continue;
      if (pointToSegment(px, py, a[0], a[1], b[0], b[1]) <= EDGE_HIT_RADIUS_PX) {
        return { from: edge.from.id, to: edge.to.id };
      }
    }
    return null;
  }

  /* ---- raw config lookups ---- */

  private rawNode(id: string): NodeConfig | undefined {
    return this.host.getRaw()?.map.nodes.find((n) => n.id === id);
  }

  private rawEdge(from: string, to: string): EdgeConfig | undefined {
    const key = edgeKey(from, to);
    return this.host.getRaw()?.map.edges?.find((e) => edgeKey(e.from, e.to) === key);
  }

  /** Ids of nodes connected to `nodeId` through fixed-distance (explicit) edges. */
  private fixedNeighbors(nodeId: string): string[] {
    const raw = this.host.getRaw();
    if (!raw) return [];
    const ids: string[] = [];
    for (const e of raw.map.edges ?? []) {
      if (e.distance === undefined) continue;
      if (e.from === nodeId) ids.push(e.to);
      else if (e.to === nodeId) ids.push(e.from);
    }
    return ids;
  }

  private routesUsing(nodeId: string): string[] {
    const raw = this.host.getRaw();
    if (!raw) return [];
    return raw.robots
      .filter((r) => r.route.some((s) => (typeof s === "string" ? s : s.node) === nodeId))
      .map((r) => r.id);
  }

  /* ---- mouse / keyboard ---- */

  private onMouseDown(e: MouseEvent): void {
    if (!this.enabled) return;
    const [px, py] = this.canvasPoint(e);
    const node = this.nodeAt(px, py);
    if (node) {
      if (e.shiftKey && this.selectedNodeId && this.selectedNodeId !== node.id) {
        this.connectNodes(this.selectedNodeId, node.id);
      } else {
        this.selectedNodeId = node.id;
        this.selectedEdge = null;
        this.dragging = this.startDrag(node.id);
      }
      this.renderPanel();
      return;
    }
    const edge = this.edgeAt(px, py);
    this.selectedEdge = edge;
    this.selectedNodeId = null;
    this.renderPanel();
  }

  /**
   * Fixed-distance edges must not be stretched by dragging: with one such
   * edge the node swings on an arc around its neighbor (keeping the drawn
   * length), with two or more the node is locked (use the x/y fields).
   */
  private startDrag(id: string): { id: string; moved: boolean; arc: { anchorId: string; radius: number } | null } | null {
    const fixed = this.fixedNeighbors(id);
    if (fixed.length >= 2) {
      this.host.showMessage(
        `Node "${id}" is held by ${fixed.length} fixed-distance edges (${fixed.join(", ")}); drag is disabled. Edit x/y in the sidebar instead.`,
      );
      return null;
    }
    if (fixed.length === 1) {
      const node = this.rawNode(id);
      const anchor = this.rawNode(fixed[0]);
      if (node && anchor) {
        const radius = euclidean(node, anchor);
        if (radius > 0) return { id, moved: false, arc: { anchorId: fixed[0], radius } };
      }
    }
    return { id, moved: false, arc: null };
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.enabled || !this.dragging) return;
    const [px, py] = this.canvasPoint(e);
    const map = this.renderer.pxToMap(px, py);
    const node = this.rawNode(this.dragging.id);
    if (!map || !node) return;
    let x: number;
    let y: number;
    const arc = this.dragging.arc;
    if (arc) {
      // Project the cursor onto the circle around the anchor (no grid snap —
      // arc positions rarely align with the grid).
      const anchor = this.rawNode(arc.anchorId);
      if (!anchor) return;
      const dx = map[0] - anchor.x;
      const dy = map[1] - anchor.y;
      const len = Math.hypot(dx, dy);
      if (len === 0) return;
      x = round2(anchor.x + (dx / len) * arc.radius);
      y = round2(anchor.y + (dy / len) * arc.radius);
    } else {
      x = this.snapValue(map[0]);
      y = this.snapValue(map[1]);
    }
    if (x === node.x && y === node.y) return;
    node.x = x;
    node.y = y;
    this.dragging.moved = true;
    this.host.applyChanges();
    this.updatePositionInputs(x, y);
  }

  private onDoubleClick(e: MouseEvent): void {
    if (!this.enabled) return;
    const [px, py] = this.canvasPoint(e);
    if (this.nodeAt(px, py) || this.edgeAt(px, py)) return;
    const map = this.renderer.pxToMap(px, py);
    const raw = this.host.getRaw();
    if (!map || !raw) return;
    const id = this.nextNodeId(raw);
    raw.map.nodes.push({ id, x: this.snapValue(map[0]), y: this.snapValue(map[1]) });
    if (this.host.applyChanges()) {
      this.selectedNodeId = id;
      this.selectedEdge = null;
      this.renderPanel();
    }
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.enabled) return;
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA") return;
    if (this.selectedNodeId) this.deleteNode(this.selectedNodeId);
    else if (this.selectedEdge) this.deleteEdge(this.selectedEdge);
  }

  /* ---- mutations ---- */

  private nextNodeId(raw: FleetConfig): string {
    const used = new Set(raw.map.nodes.map((n) => n.id));
    for (let i = 1; ; i++) {
      if (!used.has(`N${i}`)) return `N${i}`;
    }
  }

  private connectNodes(fromId: string, toId: string): void {
    const raw = this.host.getRaw();
    if (!raw) return;
    if (!this.rawEdge(fromId, toId)) {
      raw.map.edges ??= [];
      raw.map.edges.push({ from: fromId, to: toId });
      if (!this.host.applyChanges()) return;
    }
    this.selectedEdge = { from: fromId, to: toId };
    this.selectedNodeId = null;
  }

  private deleteNode(id: string): void {
    const raw = this.host.getRaw();
    if (!raw) return;
    const users = this.routesUsing(id);
    if (users.length > 0) {
      this.host.showMessage(`Cannot delete node "${id}": used by route of ${users.join(", ")}. Edit the robot's route first.`);
      return;
    }
    raw.map.nodes = raw.map.nodes.filter((n) => n.id !== id);
    if (raw.map.edges) raw.map.edges = raw.map.edges.filter((e) => e.from !== id && e.to !== id);
    if (this.host.applyChanges()) {
      this.selectedNodeId = null;
      this.renderPanel();
    }
  }

  private deleteEdge(sel: { from: string; to: string }): void {
    const raw = this.host.getRaw();
    if (!raw) return;
    const key = edgeKey(sel.from, sel.to);
    const before = raw.map.edges?.length ?? 0;
    if (raw.map.edges) raw.map.edges = raw.map.edges.filter((e) => edgeKey(e.from, e.to) !== key);
    if ((raw.map.edges?.length ?? 0) === before) {
      this.host.showMessage(`Edge ${sel.from}–${sel.to} is implied by a robot route; it disappears only when no route travels it.`);
      this.selectedEdge = null;
      this.renderPanel();
      return;
    }
    if (this.host.applyChanges()) {
      this.selectedEdge = null;
      this.renderPanel();
    }
  }

  private renameNode(oldId: string, newId: string): void {
    const raw = this.host.getRaw();
    if (!raw) return;
    newId = newId.trim();
    if (newId === "" || newId === oldId) {
      this.renderPanel();
      return;
    }
    if (raw.map.nodes.some((n) => n.id === newId)) {
      this.host.showMessage(`Node id "${newId}" is already taken.`);
      this.renderPanel();
      return;
    }
    const node = this.rawNode(oldId);
    if (!node) return;
    node.id = newId;
    for (const e of raw.map.edges ?? []) {
      if (e.from === oldId) e.from = newId;
      if (e.to === oldId) e.to = newId;
    }
    for (const robot of raw.robots) {
      robot.route = robot.route.map((s): string | RouteStop => {
        if (typeof s === "string") return s === oldId ? newId : s;
        return s.node === oldId ? { ...s, node: newId } : s;
      });
    }
    if (this.host.applyChanges()) {
      this.selectedNodeId = newId;
      this.renderPanel();
    }
  }

  private setEdgeDistance(sel: { from: string; to: string }, text: string): void {
    const raw = this.host.getRaw();
    if (!raw) return;
    const existing = this.rawEdge(sel.from, sel.to);
    if (text.trim() === "") {
      // Back to automatic (Euclidean) distance.
      if (existing) delete existing.distance;
      this.host.applyChanges();
      this.renderPanel();
      return;
    }
    const value = Number(text);
    if (!Number.isFinite(value) || value <= 0) {
      this.host.showMessage("Distance must be a positive number (leave empty for automatic).");
      this.renderPanel();
      return;
    }
    if (existing) {
      existing.distance = value;
    } else {
      raw.map.edges ??= [];
      raw.map.edges.push({ from: sel.from, to: sel.to, distance: value });
    }
    this.host.applyChanges();
    this.renderPanel();
  }

  /* ---- panel DOM ---- */

  private updatePositionInputs(x: number, y: number): void {
    const xi = this.panel.querySelector<HTMLInputElement>('input[data-field="x"]');
    const yi = this.panel.querySelector<HTMLInputElement>('input[data-field="y"]');
    if (xi) xi.value = String(x);
    if (yi) yi.value = String(y);
  }

  renderPanel(): void {
    if (!this.enabled) return;
    this.panel.replaceChildren();
    const title = el("h2", {}, "Map editor");

    const snapLabel = el("label", { class: "field" }, "Grid snap ");
    const snapSelect = el("select", {}) as HTMLSelectElement;
    for (const [value, text] of [
      ["1", "1 m"],
      ["0.5", "0.5 m"],
      ["0.25", "0.25 m"],
      ["0.1", "0.1 m"],
      ["0", "off"],
    ]) {
      const o = el("option", { value }, text) as HTMLOptionElement;
      o.selected = Number(value) === this.snap;
      snapSelect.append(o);
    }
    snapSelect.addEventListener("change", () => (this.snap = Number(snapSelect.value)));
    snapLabel.append(snapSelect);

    const help = el(
      "p",
      { class: "hint" },
      "Double-click empty space: add node · Drag node: move (snapped) · Shift+click another node: connect edge · Del: delete selection",
    );

    this.panel.append(title, snapLabel, help);

    if (this.selectedNodeId) this.renderNodeForm(this.selectedNodeId);
    else if (this.selectedEdge) this.renderEdgeForm(this.selectedEdge);
    else this.panel.append(el("p", { class: "hint" }, "Nothing selected."));
  }

  private renderNodeForm(id: string): void {
    const node = this.rawNode(id);
    if (!node) return;
    const form = el("div", { class: "editor-form" });
    form.append(el("h3", {}, `Node ${id}`));

    const idInput = textField(form, "id", node.id);
    idInput.addEventListener("change", () => this.renameNode(id, idInput.value));

    const labelInput = textField(form, "label", node.label ?? "");
    labelInput.placeholder = id;
    labelInput.addEventListener("change", () => {
      if (labelInput.value.trim() === "") delete node.label;
      else node.label = labelInput.value.trim();
      this.host.applyChanges();
    });

    for (const field of ["x", "y"] as const) {
      const input = textField(form, `${field} (m)`, String(node[field]));
      input.dataset.field = field;
      input.type = "number";
      input.step = "any";
      input.addEventListener("change", () => {
        const v = Number(input.value);
        if (!Number.isFinite(v)) return;
        node[field] = this.snapValue(v);
        this.host.applyChanges();
        input.value = String(node[field]);
      });
    }

    const usedBy = this.routesUsing(id);
    if (usedBy.length > 0) form.append(el("p", { class: "hint" }, `On route of: ${usedBy.join(", ")}`));

    const fixed = this.fixedNeighbors(id);
    if (fixed.length === 1) {
      form.append(el("p", { class: "hint" }, `Fixed-distance edge to ${fixed[0]}: dragging swings this node on an arc (drawn length kept).`));
    } else if (fixed.length >= 2) {
      form.append(el("p", { class: "hint" }, `Held by fixed-distance edges to ${fixed.join(", ")}: dragging is disabled, edit x/y here.`));
    }

    const del = el("button", { class: "danger" }, "Delete node") as HTMLButtonElement;
    del.addEventListener("click", () => this.deleteNode(id));
    form.append(del);
    this.panel.append(form);
  }

  private renderEdgeForm(sel: { from: string; to: string }): void {
    const raw = this.host.getRaw();
    if (!raw) return;
    const a = this.rawNode(sel.from);
    const b = this.rawNode(sel.to);
    if (!a || !b) return;
    const existing = this.rawEdge(sel.from, sel.to);
    const auto = euclidean(a, b);

    const form = el("div", { class: "editor-form" });
    form.append(el("h3", {}, `Edge ${sel.from} – ${sel.to}`));

    const dist = textField(form, "distance (m)", existing?.distance !== undefined ? String(existing.distance) : "");
    dist.type = "number";
    dist.step = "any";
    dist.min = "0";
    dist.placeholder = `auto: ${auto.toFixed(2)}`;
    dist.addEventListener("change", () => this.setEdgeDistance(sel, dist.value));
    form.append(el("p", { class: "hint" }, "Leave empty to use the straight-line distance."));

    const del = el("button", { class: "danger" }, "Delete edge") as HTMLButtonElement;
    del.addEventListener("click", () => this.deleteEdge(sel));
    form.append(del);
    this.panel.append(form);
  }
}

/* ---- small DOM / math helpers ---- */

function el(tag: string, attrs: Record<string, string>, text?: string): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

function textField(parent: HTMLElement, label: string, value: string): HTMLInputElement {
  const wrap = el("label", { class: "field" }, `${label} `);
  const input = el("input", {}) as HTMLInputElement;
  input.value = value;
  wrap.append(input);
  parent.append(wrap);
  return input;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function pointToSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
