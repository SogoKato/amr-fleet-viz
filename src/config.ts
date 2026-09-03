import type {
  FleetConfig,
  MapEdge,
  MapNode,
  ResolvedConfig,
  ResolvedRobot,
  ResolvedStop,
  RobotConfig,
  RouteStop,
} from "./types";

const DEFAULT_COLORS = [
  "#e5484d",
  "#3e63dd",
  "#30a46c",
  "#f76b15",
  "#8e4ec6",
  "#00a2c7",
  "#ffe629",
  "#e93d82",
];

export class ConfigError extends Error {}

function fail(message: string): never {
  throw new ConfigError(message);
}

export function edgeKey(a: string, b: string): string {
  return a < b ? `${a}\0${b}` : `${b}\0${a}`;
}

export function euclidean(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Validate a raw parsed JSON object and resolve it into the simulator model. */
export function resolveConfig(raw: unknown): ResolvedConfig {
  const cfg = raw as FleetConfig;
  if (typeof cfg !== "object" || cfg === null) fail("config must be a JSON object");
  if (!cfg.map || !Array.isArray(cfg.map.nodes)) fail("config.map.nodes must be an array");
  if (!Array.isArray(cfg.robots)) fail("config.robots must be an array");

  const nodes: MapNode[] = [];
  const nodeById = new Map<string, MapNode>();
  for (const n of cfg.map.nodes) {
    if (!n || typeof n.id !== "string" || n.id === "") fail("every node needs a string id");
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) fail(`node "${n.id}": x/y must be numbers`);
    if (nodeById.has(n.id)) fail(`duplicate node id "${n.id}"`);
    const node: MapNode = { id: n.id, x: n.x, y: n.y, label: n.label ?? n.id };
    nodes.push(node);
    nodeById.set(node.id, node);
  }

  const lookupNode = (id: string, context: string): MapNode =>
    nodeById.get(id) ?? fail(`${context}: unknown node id "${id}"`);

  const edges = new Map<string, MapEdge>();
  for (const e of cfg.map.edges ?? []) {
    const from = lookupNode(e.from, "edge");
    const to = lookupNode(e.to, "edge");
    if (from === to) fail(`edge "${e.from}"-"${e.to}": endpoints must differ`);
    if (e.distance !== undefined && (!Number.isFinite(e.distance) || e.distance <= 0)) {
      fail(`edge "${e.from}"-"${e.to}": distance must be a positive number`);
    }
    const key = edgeKey(from.id, to.id);
    if (edges.has(key)) fail(`duplicate edge "${e.from}"-"${e.to}"`);
    edges.set(key, {
      from,
      to,
      distance: e.distance ?? euclidean(from, to),
      explicit: e.distance !== undefined,
    });
  }

  const robots: ResolvedRobot[] = [];
  const robotIds = new Set<string>();
  cfg.robots.forEach((r, index) => {
    if (!r || typeof r.id !== "string" || r.id === "") fail(`robot #${index + 1} needs a string id`);
    if (robotIds.has(r.id)) fail(`duplicate robot id "${r.id}"`);
    robotIds.add(r.id);
    if (!Number.isFinite(r.speedMps) || r.speedMps <= 0) {
      fail(`robot "${r.id}": speedMps must be a positive number`);
    }
    if (!Number.isFinite(r.turnDurationSec) || r.turnDurationSec < 0) {
      fail(`robot "${r.id}": turnDurationSec must be a non-negative number`);
    }
    if (r.startDelaySec !== undefined && (!Number.isFinite(r.startDelaySec) || r.startDelaySec < 0)) {
      fail(`robot "${r.id}": startDelaySec must be a non-negative number`);
    }
    if (r.route !== undefined && !Array.isArray(r.route)) fail(`robot "${r.id}": route must be an array`);
    if (r.loop !== undefined && typeof r.loop !== "boolean" && !Array.isArray(r.loop)) {
      fail(`robot "${r.id}": loop must be a boolean or an array of stops`);
    }
    if (r.route === undefined && !Array.isArray(r.loop)) {
      fail(`robot "${r.id}": route is required unless loop is an array of stops`);
    }

    const resolveStops = (entries: (string | RouteStop)[], context: string): ResolvedStop[] =>
      entries.map((entry) => {
        const stop: RouteStop = typeof entry === "string" ? { node: entry } : entry;
        if (!stop || typeof stop.node !== "string") fail(`robot "${r.id}": invalid ${context} entry`);
        if (stop.waitSec !== undefined && (!Number.isFinite(stop.waitSec) || stop.waitSec < 0)) {
          fail(`robot "${r.id}": waitSec at "${stop.node}" must be a non-negative number`);
        }
        return { node: lookupNode(stop.node, `robot "${r.id}" ${context}`), waitSec: stop.waitSec ?? 0 };
      });

    const routeStops = resolveStops(r.route ?? [], "route");
    let route: ResolvedStop[];
    let loop: ResolvedStop[];
    if (Array.isArray(r.loop)) {
      route = routeStops;
      loop = resolveStops(r.loop, "loop");
    } else {
      route = r.loop ? [] : routeStops;
      loop = r.loop ? routeStops : [];
    }

    // Everything the robot travels before the loop starts repeating.
    // Consecutive stops must differ, including across the route → loop boundary.
    const path = [...route, ...loop];
    for (let i = 1; i < path.length; i++) {
      if (path[i].node === path[i - 1].node) {
        fail(`robot "${r.id}": consecutive route stops must differ ("${path[i].node.id}")`);
      }
    }

    // Register the edges this robot travels so the renderer can draw them
    // and the simulator can look up their distances.
    const hops = path.map((s) => s.node);
    if (loop.length > 0 && hops[hops.length - 1] !== loop[0].node) hops.push(loop[0].node);
    for (let i = 1; i < hops.length; i++) {
      const key = edgeKey(hops[i - 1].id, hops[i].id);
      if (!edges.has(key)) {
        edges.set(key, {
          from: hops[i - 1],
          to: hops[i],
          distance: euclidean(hops[i - 1], hops[i]),
          explicit: false,
        });
      }
    }

    robots.push({
      id: r.id,
      color: r.color ?? DEFAULT_COLORS[index % DEFAULT_COLORS.length],
      speedMps: r.speedMps,
      turnDurationSec: r.turnDurationSec,
      route,
      loop,
      startDelaySec: r.startDelaySec ?? 0,
    });
  });

  return {
    name: cfg.name ?? "Untitled scenario",
    nodes,
    edges: [...edges.values()],
    robots,
  };
}

/** A robot's raw stops in travel order, plus the index of the stop its loop starts at (null when it doesn't loop). */
export function robotPath(robot: RobotConfig): { stops: (string | RouteStop)[]; loopFrom: number | null } {
  const route = robot.route ?? [];
  if (Array.isArray(robot.loop)) return { stops: [...route, ...robot.loop], loopFrom: route.length };
  return { stops: [...route], loopFrom: robot.loop ? 0 : null };
}

/** Inverse of `robotPath`: store a stop list back into `route` / `loop`, using the shortest form. */
export function setRobotPath(robot: RobotConfig, stops: (string | RouteStop)[], loopFrom: number | null): void {
  if (loopFrom === null) {
    robot.route = stops;
    delete robot.loop;
  } else if (loopFrom === 0) {
    robot.route = stops;
    robot.loop = true;
  } else {
    robot.route = stops.slice(0, loopFrom);
    robot.loop = stops.slice(loopFrom);
  }
}

export function stopNode(entry: string | RouteStop): string {
  return typeof entry === "string" ? entry : entry.node;
}

/** Distance between two adjacent nodes, honoring explicit edge overrides. */
export function hopDistance(config: ResolvedConfig, a: MapNode, b: MapNode): number {
  const key = edgeKey(a.id, b.id);
  const edge = config.edges.find((e) => edgeKey(e.from.id, e.to.id) === key);
  return edge ? edge.distance : euclidean(a, b);
}
