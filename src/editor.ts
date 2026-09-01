import { edgeKey, euclidean } from "./config";
import type { Highlight, Renderer } from "./renderer";
import type { EdgeConfig, FleetConfig, MapNode, NodeConfig, ResolvedConfig, RobotConfig, RouteStop } from "./types";

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
  private selectedRobotId: string | null = null;
  /** While true, clicking nodes appends them to the selected robot's route. */
  private routeArmed = false;
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
    this.clearSelection();
    this.panel.style.display = on ? "block" : "none";
    document.body.classList.toggle("editing", on);
    this.renderPanel();
  }

  /** Called by the host after a new config is loaded. */
  reset(): void {
    this.clearSelection();
    this.renderPanel();
  }

  private clearSelection(): void {
    this.selectedNodeId = null;
    this.selectedEdge = null;
    this.selectedRobotId = null;
    this.routeArmed = false;
    this.dragging = null;
  }

  highlight(): Highlight | null {
    if (!this.enabled) return null;
    let route: Highlight["route"] = null;
    if (this.selectedRobotId) {
      const robot = this.host.getResolved()?.robots.find((r) => r.id === this.selectedRobotId);
      if (robot) {
        route = {
          color: robot.color,
          loop: robot.loop,
          stops: robot.stops.map((s) => ({ x: s.node.x, y: s.node.y })),
        };
      }
    }
    return { nodeId: this.selectedNodeId, edge: this.selectedEdge, route };
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
      if (this.routeArmed && this.selectedRobotId) {
        this.appendStop(node.id);
        return;
      }
      if (e.shiftKey && this.selectedNodeId && this.selectedNodeId !== node.id) {
        this.connectNodes(this.selectedNodeId, node.id);
      } else {
        this.selectedNodeId = node.id;
        this.selectedEdge = null;
        this.selectedRobotId = null;
        this.routeArmed = false;
        this.dragging = this.startDrag(node.id);
      }
      this.renderPanel();
      return;
    }
    if (this.routeArmed) return; // keep the route-editing selection on stray clicks
    const edge = this.edgeAt(px, py);
    this.selectedEdge = edge;
    this.selectedNodeId = null;
    this.selectedRobotId = null;
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
    if (e.key === "Escape" && this.routeArmed) {
      this.routeArmed = false;
      this.renderPanel();
      return;
    }
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

  /* ---- robot mutations ---- */

  private rawRobot(id: string): RobotConfig | undefined {
    return this.host.getRaw()?.robots.find((r) => r.id === id);
  }

  private addRobot(): void {
    const raw = this.host.getRaw();
    if (!raw) return;
    const used = new Set(raw.robots.map((r) => r.id));
    let id = "";
    for (let i = 1; id === ""; i++) if (!used.has(`R${i}`)) id = `R${i}`;
    raw.robots.push({ id, speedMps: 1, turnDurationSec: 2, loop: true, route: [] });
    if (this.host.applyChanges()) {
      this.selectRobot(id);
      this.routeArmed = true; // start picking the route right away
      this.renderPanel();
    }
  }

  private deleteRobot(id: string): void {
    const raw = this.host.getRaw();
    if (!raw) return;
    raw.robots = raw.robots.filter((r) => r.id !== id);
    if (this.host.applyChanges()) {
      this.selectedRobotId = null;
      this.routeArmed = false;
      this.renderPanel();
    }
  }

  private selectRobot(id: string): void {
    this.selectedRobotId = id;
    this.selectedNodeId = null;
    this.selectedEdge = null;
    this.routeArmed = false;
  }

  private appendStop(nodeId: string): void {
    const robot = this.selectedRobotId ? this.rawRobot(this.selectedRobotId) : undefined;
    if (!robot) return;
    const last = robot.route[robot.route.length - 1];
    if (last !== undefined && (typeof last === "string" ? last : last.node) === nodeId) {
      this.host.showMessage(`"${nodeId}" is already the last stop — consecutive stops must differ.`);
      return;
    }
    robot.route.push(nodeId);
    if (this.host.applyChanges()) this.renderPanel();
  }

  private removeStop(index: number): void {
    const robot = this.selectedRobotId ? this.rawRobot(this.selectedRobotId) : undefined;
    if (!robot) return;
    const next = robot.route.filter((_, i) => i !== index);
    // Removing a middle stop may leave two identical neighbors; drop the second.
    for (let i = 1; i < next.length; i++) {
      const a = typeof next[i - 1] === "string" ? next[i - 1] : (next[i - 1] as RouteStop).node;
      const b = typeof next[i] === "string" ? next[i] : (next[i] as RouteStop).node;
      if (a === b) next.splice(i, 1);
    }
    robot.route = next;
    if (this.host.applyChanges()) this.renderPanel();
  }

  private setStopWait(index: number, text: string): void {
    const robot = this.selectedRobotId ? this.rawRobot(this.selectedRobotId) : undefined;
    if (!robot || robot.route[index] === undefined) return;
    const entry = robot.route[index];
    const nodeId = typeof entry === "string" ? entry : entry.node;
    const value = text.trim() === "" ? 0 : Number(text);
    if (!Number.isFinite(value) || value < 0) {
      this.host.showMessage("Wait must be a non-negative number of seconds.");
      this.renderPanel();
      return;
    }
    robot.route[index] = value > 0 ? { node: nodeId, waitSec: value } : nodeId;
    this.host.applyChanges();
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

    this.renderRobotSection();
  }

  private renderRobotSection(): void {
    const raw = this.host.getRaw();
    if (!raw) return;
    this.panel.append(el("h3", {}, "Robots"));
    const chips = el("div", { class: "robot-chips" });
    for (const robot of raw.robots) {
      const chip = el("button", { class: robot.id === this.selectedRobotId ? "chip selected" : "chip" }, robot.id) as HTMLButtonElement;
      const resolved = this.host.getResolved()?.robots.find((r) => r.id === robot.id);
      if (resolved) chip.style.borderColor = resolved.color;
      chip.addEventListener("click", () => {
        this.selectRobot(robot.id);
        this.renderPanel();
      });
      chips.append(chip);
    }
    const add = el("button", { class: "chip" }, "+ Add robot") as HTMLButtonElement;
    add.addEventListener("click", () => this.addRobot());
    chips.append(add);
    this.panel.append(chips);

    if (this.selectedRobotId) this.renderRobotForm(this.selectedRobotId);
  }

  private renderRobotForm(id: string): void {
    const robot = this.rawRobot(id);
    if (!robot) return;
    const form = el("div", { class: "editor-form" });

    const idInput = textField(form, "id", robot.id);
    idInput.addEventListener("change", () => {
      const newId = idInput.value.trim();
      if (newId === "" || newId === id) return this.renderPanel();
      if (this.host.getRaw()?.robots.some((r) => r.id === newId)) {
        this.host.showMessage(`Robot id "${newId}" is already taken.`);
        return this.renderPanel();
      }
      robot.id = newId;
      if (this.host.applyChanges()) this.selectedRobotId = newId;
      this.renderPanel();
    });

    const numeric = (label: string, key: "speedMps" | "turnDurationSec" | "startDelaySec") => {
      const input = textField(form, label, robot[key] !== undefined ? String(robot[key]) : "");
      input.type = "number";
      input.step = "any";
      input.min = "0";
      input.addEventListener("change", () => {
        if (input.value.trim() === "" && key === "startDelaySec") delete robot[key];
        else robot[key] = Number(input.value);
        this.host.applyChanges();
        this.renderPanel();
      });
    };
    numeric("speed (m/s)", "speedMps");
    numeric("turn time (s)", "turnDurationSec");
    numeric("start delay (s)", "startDelaySec");

    const resolved = this.host.getResolved()?.robots.find((r) => r.id === id);
    const colorWrap = el("label", { class: "field" }, "color ");
    const colorInput = el("input", { type: "color" }) as HTMLInputElement;
    colorInput.value = robot.color ?? resolved?.color ?? "#888888";
    colorInput.addEventListener("change", () => {
      robot.color = colorInput.value;
      this.host.applyChanges();
    });
    colorWrap.append(colorInput);
    form.append(colorWrap);

    const loopWrap = el("label", { class: "field" }, "loop ");
    const loopInput = el("input", { type: "checkbox" }) as HTMLInputElement;
    loopInput.checked = robot.loop ?? false;
    loopInput.addEventListener("change", () => {
      robot.loop = loopInput.checked;
      this.host.applyChanges();
    });
    loopWrap.append(loopInput);
    form.append(loopWrap);

    // Route
    form.append(el("h3", {}, "Route"));
    const armBtn = el("button", { class: this.routeArmed ? "primary" : "" }, this.routeArmed ? "Picking… (Esc to stop)" : "Pick stops on map") as HTMLButtonElement;
    armBtn.addEventListener("click", () => {
      this.routeArmed = !this.routeArmed;
      this.renderPanel();
    });
    form.append(armBtn);
    if (this.routeArmed) form.append(el("p", { class: "hint" }, "Click waypoints on the canvas to append them to the route."));

    if (robot.route.length === 0) {
      form.append(el("p", { class: "hint" }, "No stops yet — the robot is parked off-map until the route has 2+ stops."));
    }
    robot.route.forEach((entry, index) => {
      const stop: RouteStop = typeof entry === "string" ? { node: entry } : entry;
      const row = el("div", { class: "stop-row" });
      row.append(el("span", { class: "stop-index" }, String(index + 1)), el("span", { class: "stop-node" }, stop.node));
      const wait = el("input", { type: "number", step: "any", min: "0", placeholder: "wait s" }) as HTMLInputElement;
      wait.value = stop.waitSec !== undefined && stop.waitSec > 0 ? String(stop.waitSec) : "";
      wait.addEventListener("change", () => this.setStopWait(index, wait.value));
      const remove = el("button", { class: "stop-remove", title: "Remove stop" }, "×") as HTMLButtonElement;
      remove.addEventListener("click", () => this.removeStop(index));
      row.append(wait, remove);
      form.append(row);
    });

    const del = el("button", { class: "danger" }, "Delete robot") as HTMLButtonElement;
    del.addEventListener("click", () => this.deleteRobot(id));
    form.append(del);
    this.panel.append(form);
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
