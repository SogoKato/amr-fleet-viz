/** Configuration file schema (JSON). All coordinates and distances are in meters. */

export interface NodeConfig {
  /** Unique node id, referenced from edges and routes. */
  id: string;
  x: number;
  y: number;
  /** Optional display label; defaults to the id. */
  label?: string;
}

export interface EdgeConfig {
  from: string;
  to: string;
  /**
   * Travel distance in meters. When omitted, the Euclidean distance
   * between the two nodes is used. An explicit value overrides it
   * (e.g. to model a detour that is not drawn on the map).
   */
  distance?: number;
}

/** A stop on a robot's route. A bare string is shorthand for { node } with no wait. */
export interface RouteStop {
  node: string;
  /** Seconds to pause at this node before departing. Default 0. */
  waitSec?: number;
}

export interface RobotConfig {
  id: string;
  /** CSS color used for rendering. Auto-assigned when omitted. */
  color?: string;
  /** Straight-line speed in meters per second. */
  speedMps: number;
  /** Seconds spent on each in-place turn (whenever the travel direction changes). */
  turnDurationSec: number;
  /**
   * Ordered list of stops to visit once. With `loop` set to a stop list this
   * is the lead-in travelled before entering the loop and may be omitted
   * (the robot then starts at the loop's first stop).
   */
  route?: (string | RouteStop)[];
  /**
   * Repeat forever. `true` repeats `route` itself, returning to its first
   * stop. A stop list is travelled after `route` and then repeated forever,
   * returning to its own first stop (an implicit closing hop is added when
   * the list doesn't already end there). Default false.
   */
  loop?: boolean | (string | RouteStop)[];
  /** Seconds to hold at the first stop before the very first departure. Default 0. */
  startDelaySec?: number;
}

export interface FleetConfig {
  /** Display name of the scenario. */
  name?: string;
  map: {
    nodes: NodeConfig[];
    /** Optional explicit edges; route hops without an edge fall back to Euclidean distance. */
    edges?: EdgeConfig[];
  };
  robots: RobotConfig[];
}

/* ---- Resolved (validated) model used by the simulator ---- */

export interface MapNode {
  id: string;
  x: number;
  y: number;
  label: string;
}

export interface MapEdge {
  from: MapNode;
  to: MapNode;
  distance: number;
  explicit: boolean;
}

export interface ResolvedStop {
  node: MapNode;
  waitSec: number;
}

export interface ResolvedRobot {
  id: string;
  color: string;
  speedMps: number;
  turnDurationSec: number;
  /** Stops travelled once, in order. Empty only when the robot starts directly on its loop. */
  route: ResolvedStop[];
  /** Stops repeated forever after `route`; empty when the robot goes idle at the end of `route`. */
  loop: ResolvedStop[];
  startDelaySec: number;
}

export interface ResolvedConfig {
  name: string;
  nodes: MapNode[];
  /** Explicit edges plus edges implied by robot routes (for drawing and distances). */
  edges: MapEdge[];
  robots: ResolvedRobot[];
}
