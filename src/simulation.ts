import { hopDistance } from "./config";
import type { MapNode, ResolvedConfig, ResolvedRobot } from "./types";

export type Phase = "waiting" | "turning" | "moving" | "idle";

interface Segment {
  phase: Phase;
  start: number;
  end: number;
  /** Position anchors: `from`/`to` for moves, `at` for everything else. */
  from?: MapNode;
  to?: MapNode;
  at?: MapNode;
  headingFrom: number;
  headingTo: number;
}

export interface RobotState {
  robot: ResolvedRobot;
  x: number;
  y: number;
  /** Heading in radians (map coordinates, 0 = +x). */
  heading: number;
  phase: Phase;
  /** Human-readable status, e.g. `moving A → B`. */
  status: string;
  /** Seconds remaining in the current segment (Infinity when idle). */
  remainingSec: number;
  /** False for robots without a route: they have no position and are not drawn. */
  placed: boolean;
}

const TURN_EPSILON = 0.01; // radians; direction changes smaller than this need no turn

function headingOf(from: MapNode, to: MapNode): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

/** Shortest signed angular difference from `a` to `b`, in (-PI, PI]. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Precomputed timeline for one robot. */
class RobotTimeline {
  readonly robot: ResolvedRobot;
  private readonly segments: Segment[] = [];
  private readonly cycleStart: number;
  private readonly cycleDuration: number;

  constructor(config: ResolvedConfig, robot: ResolvedRobot) {
    this.robot = robot;
    const stops = robot.stops;
    if (stops.length === 0) {
      this.cycleStart = 0;
      this.cycleDuration = 0;
      return;
    }
    const first = stops[0].node;

    // Hops travelled in one pass; a loop returns to the first stop when needed.
    const hopTargets: { to: MapNode; waitSecOnArrival: number }[] = [];
    for (let i = 1; i < stops.length; i++) {
      hopTargets.push({ to: stops[i].node, waitSecOnArrival: stops[i].waitSec });
    }
    if (robot.loop && stops[stops.length - 1].node !== first) {
      hopTargets.push({ to: first, waitSecOnArrival: stops[0].waitSec });
    }

    // Looping robots start facing the way they will face on every later lap
    // (the direction they arrive from), so one precomputed cycle repeats exactly.
    let heading = 0;
    if (hopTargets.length > 0) {
      const lastFrom = hopTargets.length >= 2 ? hopTargets[hopTargets.length - 2].to : first;
      heading = robot.loop
        ? headingOf(lastFrom, hopTargets[hopTargets.length - 1].to)
        : headingOf(first, hopTargets[0].to);
    }

    let t = 0;
    if (robot.startDelaySec > 0) {
      this.push({ phase: "idle", start: t, end: t + robot.startDelaySec, at: first, headingFrom: heading, headingTo: heading });
      t += robot.startDelaySec;
    }
    this.cycleStart = t;

    let current = first;
    let pendingWait = stops[0].waitSec;
    for (const hop of hopTargets) {
      if (pendingWait > 0) {
        this.push({ phase: "waiting", start: t, end: t + pendingWait, at: current, headingFrom: heading, headingTo: heading });
        t += pendingWait;
      }
      const targetHeading = headingOf(current, hop.to);
      if (Math.abs(angleDelta(heading, targetHeading)) > TURN_EPSILON && robot.turnDurationSec > 0) {
        this.push({ phase: "turning", start: t, end: t + robot.turnDurationSec, at: current, headingFrom: heading, headingTo: targetHeading });
        t += robot.turnDurationSec;
      }
      heading = targetHeading;
      const travelSec = hopDistance(config, current, hop.to) / robot.speedMps;
      this.push({ phase: "moving", start: t, end: t + travelSec, from: current, to: hop.to, headingFrom: heading, headingTo: heading });
      t += travelSec;
      current = hop.to;
      pendingWait = hop.waitSecOnArrival;
    }
    if (!robot.loop && pendingWait > 0) {
      this.push({ phase: "waiting", start: t, end: t + pendingWait, at: current, headingFrom: heading, headingTo: heading });
      t += pendingWait;
    }
    this.cycleDuration = t - this.cycleStart;
  }

  private push(segment: Segment): void {
    if (segment.end > segment.start) this.segments.push(segment);
  }

  stateAt(time: number): RobotState {
    const stops = this.robot.stops;
    if (stops.length === 0) {
      return {
        robot: this.robot,
        x: 0,
        y: 0,
        heading: 0,
        phase: "idle",
        status: "no route",
        remainingSec: Infinity,
        placed: false,
      };
    }
    if (time < 0) time = 0;

    let localTime = time;
    if (this.robot.loop && this.cycleDuration > 0 && time >= this.cycleStart) {
      localTime = this.cycleStart + ((time - this.cycleStart) % this.cycleDuration);
    }

    const segment = this.segments.find((s) => localTime >= s.start && localTime < s.end);
    if (!segment) {
      // Non-looping robot that finished its route (or a robot with an empty timeline).
      const last = stops[stops.length - 1].node;
      const lastSegment = this.segments[this.segments.length - 1];
      return {
        robot: this.robot,
        x: last.x,
        y: last.y,
        heading: lastSegment?.headingTo ?? 0,
        phase: "idle",
        status: `idle at ${last.label}`,
        remainingSec: Infinity,
        placed: true,
      };
    }

    const progress = (localTime - segment.start) / (segment.end - segment.start);
    const remainingSec = segment.end - localTime;
    switch (segment.phase) {
      case "moving": {
        const { from, to } = segment as Required<Pick<Segment, "from" | "to">> & Segment;
        return {
          robot: this.robot,
          x: from.x + (to.x - from.x) * progress,
          y: from.y + (to.y - from.y) * progress,
          heading: segment.headingFrom,
          phase: "moving",
          status: `moving ${from.label} → ${to.label}`,
          remainingSec,
          placed: true,
        };
      }
      case "turning": {
        const at = segment.at!;
        const heading = segment.headingFrom + angleDelta(segment.headingFrom, segment.headingTo) * progress;
        return {
          robot: this.robot,
          x: at.x,
          y: at.y,
          heading,
          phase: "turning",
          status: `turning at ${at.label}`,
          remainingSec,
          placed: true,
        };
      }
      case "waiting":
      case "idle": {
        const at = segment.at!;
        return {
          robot: this.robot,
          x: at.x,
          y: at.y,
          heading: segment.headingFrom,
          phase: segment.phase,
          status:
            segment.phase === "waiting"
              ? `waiting at ${at.label} (${remainingSec.toFixed(1)}s)`
              : `holding at ${at.label} (${remainingSec.toFixed(1)}s)`,
          remainingSec,
          placed: true,
        };
      }
    }
  }
}

export class Simulation {
  readonly config: ResolvedConfig;
  private readonly timelines: RobotTimeline[];

  constructor(config: ResolvedConfig) {
    this.config = config;
    this.timelines = config.robots.map((robot) => new RobotTimeline(config, robot));
  }

  statesAt(time: number): RobotState[] {
    return this.timelines.map((timeline) => timeline.stateAt(time));
  }
}

/** Pairs of robots closer than `thresholdMeters`, for proximity highlighting. */
export function proximityPairs(states: RobotState[], thresholdMeters: number): [RobotState, RobotState][] {
  const pairs: [RobotState, RobotState][] = [];
  for (let i = 0; i < states.length; i++) {
    for (let j = i + 1; j < states.length; j++) {
      if (!states[i].placed || !states[j].placed) continue;
      if (Math.hypot(states[i].x - states[j].x, states[i].y - states[j].y) < thresholdMeters) {
        pairs.push([states[i], states[j]]);
      }
    }
  }
  return pairs;
}
