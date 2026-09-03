import { ConfigError, hopDistance } from "./config";
import type { MapNode, ResolvedConfig, ResolvedRobot, ResolvedStop } from "./types";

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

/** One arrival on a robot's path: where it lands and how long it pauses there. */
interface Visit {
  node: MapNode;
  waitSec: number;
  /** Arriving here completes one lap of the loop. */
  endsLap: boolean;
  /** Arriving here begins a lap of the loop (the lead-in reaching the loop, or a lap closing). */
  startsLap: boolean;
}

interface BuiltTimeline {
  segments: Segment[];
  /** Start/end times of each precomputed lap. */
  laps: { start: number; end: number }[];
  /** Time the last segment ends. */
  endTime: number;
}

/** Precomputed timeline for one robot. */
class RobotTimeline {
  readonly robot: ResolvedRobot;
  /** Every stop in travel order: the one-time route followed by the loop body. */
  private readonly path: ResolvedStop[];
  private readonly segments: Segment[];
  private readonly cycleStart: number;
  private readonly cycleDuration: number;

  constructor(config: ResolvedConfig, robot: ResolvedRobot) {
    this.robot = robot;
    const path = [...robot.route, ...robot.loop];
    this.path = path;
    if (path.length === 0) {
      this.segments = [];
      this.cycleStart = 0;
      this.cycleDuration = 0;
      return;
    }
    const first = path[0].node;
    const toVisit = (s: ResolvedStop): Visit => ({ node: s.node, waitSec: s.waitSec, endsLap: false, startsLap: false });

    // A loop of a single stop has nowhere to go; the robot just ends there.
    const looping = robot.loop.length >= 2;
    const visits: Visit[] = (looping ? robot.route : path).slice(1).map(toVisit);

    // Looping robots get two laps precomputed: the first is entered from the
    // lead-in (or from standstill) and may turn differently on departure;
    // the second is what repeats forever.
    let closingFrom = first;
    if (looping) {
      const [head, ...rest] = robot.loop;
      const lap = (): Visit[] => {
        const visits = rest.map(toVisit);
        const last = visits[visits.length - 1];
        if (last.node === head.node) {
          // The loop closes explicitly: the pause at the end and at the start
          // of the next lap happen at the same stop, back to back.
          last.waitSec += head.waitSec;
          last.endsLap = true;
        } else {
          visits.push({ node: head.node, waitSec: head.waitSec, endsLap: true, startsLap: false });
        }
        return visits;
      };
      const lap1 = lap();
      const lap2 = lap();
      lap1[lap1.length - 1].startsLap = true;
      closingFrom = lap1.length >= 2 ? lap1[lap1.length - 2].node : first;
      if (robot.route.length > 0) visits.push({ ...toVisit(head), startsLap: true });
      visits.push(...lap1, ...lap2);
    }

    // Without a lead-in, start facing the way every later lap arrives so the
    // first lap departs exactly like the rest.
    const startsOnLoop = looping && robot.route.length === 0;
    let heading = 0;
    if (startsOnLoop) heading = headingOf(closingFrom, robot.loop[0].node);
    else if (visits.length > 0) heading = headingOf(first, visits[0].node);

    const build = (pads: number[]) => this.build(config, visits, heading, startsOnLoop, looping, pads);
    let built = build([0, 0]);
    if (looping && robot.cycleSec > 0) {
      // Pad each lap to the fixed cycle; the padding differs between the
      // first lap and the repeating one when their turns differ.
      const pads = built.laps.map(({ start, end }) => {
        const natural = end - start;
        if (natural > robot.cycleSec + 1e-9) {
          throw new ConfigError(
            `robot "${robot.id}": one lap of the loop takes ${natural.toFixed(1)} s, longer than cycleSec (${robot.cycleSec})`,
          );
        }
        return robot.cycleSec - natural;
      });
      built = build(pads);
    }

    this.segments = built.segments;
    if (looping) {
      // No trailing pause: the cycle wraps to the pause recorded at the end of the first lap.
      this.cycleStart = built.laps[0].end;
      this.cycleDuration = built.laps[1].end - built.laps[0].end;
    } else {
      this.cycleStart = built.endTime;
      this.cycleDuration = 0;
    }
  }

  /**
   * Lay out segments for `visits`, starting at the path's first stop.
   * `pads[i]` is extra hold time inserted at the start of lap `i`, after its pause.
   */
  private build(
    config: ResolvedConfig,
    visits: Visit[],
    initialHeading: number,
    startsOnLoop: boolean,
    looping: boolean,
    pads: number[],
  ): BuiltTimeline {
    const robot = this.robot;
    const segments: Segment[] = [];
    const push = (segment: Segment): void => {
      if (segment.end > segment.start) segments.push(segment);
    };
    const laps: { start: number; end: number }[] = [];
    let pendingPad = 0;
    const beginLap = (at: number): void => {
      pendingPad = pads[laps.length] ?? 0;
      laps.push({ start: at, end: NaN });
    };

    let heading = initialHeading;
    let t = 0;
    let current = this.path[0].node;
    if (robot.startDelaySec > 0) {
      push({ phase: "idle", start: t, end: t + robot.startDelaySec, at: current, headingFrom: heading, headingTo: heading });
      t += robot.startDelaySec;
    }
    if (startsOnLoop) beginLap(t);

    let pendingWait = this.path[0].waitSec;
    for (const visit of visits) {
      if (pendingWait > 0) {
        push({ phase: "waiting", start: t, end: t + pendingWait, at: current, headingFrom: heading, headingTo: heading });
        t += pendingWait;
      }
      if (pendingPad > 0) {
        push({ phase: "idle", start: t, end: t + pendingPad, at: current, headingFrom: heading, headingTo: heading });
        t += pendingPad;
        pendingPad = 0;
      }
      const targetHeading = headingOf(current, visit.node);
      if (Math.abs(angleDelta(heading, targetHeading)) > TURN_EPSILON && robot.turnDurationSec > 0) {
        push({ phase: "turning", start: t, end: t + robot.turnDurationSec, at: current, headingFrom: heading, headingTo: targetHeading });
        t += robot.turnDurationSec;
      }
      heading = targetHeading;
      const travelSec = hopDistance(config, current, visit.node) / robot.speedMps;
      push({ phase: "moving", start: t, end: t + travelSec, from: current, to: visit.node, headingFrom: heading, headingTo: heading });
      t += travelSec;
      current = visit.node;
      pendingWait = visit.waitSec;
      if (visit.endsLap) laps[laps.length - 1].end = t;
      if (visit.startsLap) beginLap(t);
    }
    if (!looping && pendingWait > 0) {
      push({ phase: "waiting", start: t, end: t + pendingWait, at: current, headingFrom: heading, headingTo: heading });
      t += pendingWait;
    }
    return { segments, laps, endTime: t };
  }

  stateAt(time: number): RobotState {
    const path = this.path;
    if (path.length === 0) {
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
    if (this.cycleDuration > 0 && time >= this.cycleStart) {
      localTime = this.cycleStart + ((time - this.cycleStart) % this.cycleDuration);
    }

    const segment = this.segments.find((s) => localTime >= s.start && localTime < s.end);
    if (!segment) {
      // Non-looping robot that finished its route (or a robot with an empty timeline).
      const last = path[path.length - 1].node;
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
