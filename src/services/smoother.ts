import { destination, distance } from '../core/geo';
import type { Fix, LatLon } from '../core/types';
import { advance, bearingOnPath, pointOnPath, type PathRef } from './matching';

/** Predict at most this far past the last fix; beyond it dead reckoning (matching.ts) takes over. */
const MAX_PREDICT_MS = 2500;
/** A new fix's disagreement with the prediction is blended away over this long, not jumped. */
const CORRECTION_MS = 500;
/** Disagreements larger than this are real (a re-route, a GPS reset) and taken at once. */
const MAX_CORRECTION_M = 30;
/** Fixes within this long are used for the speed trend (acceleration). */
const TREND_WINDOW_MS = 3000;
/** Hardest believable braking and acceleration, m/s²; beyond is GPS noise. */
const MAX_DECEL = 8;
const MAX_ACCEL = 5;
/** Smaller changes than this (m/s²) are treated as steady speed: GPS speed wobbles a little. */
const MIN_ACCEL = 0.3;

/**
 * Acceleration from the trend of recent GPS speeds (least-squares slope over the last few seconds),
 * clamped to what a car can do; 0 when the change is within GPS noise.
 */
export function speedTrend(samples: { t: number; v: number }[]): number {
  if (samples.length < 2) return 0;
  const n = samples.length;
  const mt = samples.reduce((s, p) => s + p.t, 0) / n;
  const mv = samples.reduce((s, p) => s + p.v, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of samples) {
    num += (p.t - mt) * (p.v - mv);
    den += (p.t - mt) ** 2;
  }
  const a = den > 0 ? num / den : 0; // m/s per ms
  const perS = a * 1000;
  if (Math.abs(perS) < MIN_ACCEL) return 0;
  return Math.max(-MAX_DECEL, Math.min(MAX_ACCEL, perS));
}

/** Metres covered in `dt` seconds from speed `v` with constant acceleration `a`, stopping at 0. */
export function travelled(v: number, a: number, dt: number): number {
  if (a < 0 && v + a * dt < 0) return v > 0 ? (v * v) / (-2 * a) : 0; // came to a stop on the way
  return Math.max(0, v * dt + 0.5 * a * dt * dt);
}

/**
 * Fills in positions between GPS fixes (about one a second) for a 10 Hz estimate: the car is
 * carried on from the last fix at its speed, sped up or slowed down by the recent speed trend, along the route while guiding (so it turns where the
 * route turns), along the matched road otherwise, or straight along its heading. When the next fix
 * arrives, the difference from the estimate is faded out over half a second, so distances counting
 * down to a turn or a camera don't jump back.
 */
export class LocationSmoother {
  private anchor: { fix: Fix; ref: PathRef | null; at: number; accel: number } | null = null;
  private speeds: { t: number; v: number }[] = [];
  private correction: { dLat: number; dLon: number; at: number } | null = null;

  /** A new (cleaned, map-matched) fix. `ref`: where it lies on the route or road, if known. */
  update(fix: Fix, ref: PathRef | null, now = Date.now()): void {
    const predicted = this.anchor ? this.predict(now) : null;
    this.correction =
      predicted && distance(predicted, fix) < MAX_CORRECTION_M
        ? { dLat: predicted.lat - fix.lat, dLon: predicted.lon - fix.lon, at: now }
        : null;
    // Speed trend from the last few fixes, so braking and speeding up carry into the estimate.
    if (fix.speed != null) this.speeds = [...this.speeds.filter((p) => now - p.t <= TREND_WINDOW_MS), { t: now, v: fix.speed }];
    else this.speeds = [];
    this.anchor = { fix, ref, at: now, accel: speedTrend(this.speeds) };
  }

  /** Metres moved since the last fix, at `now`. */
  private moved(now: number): number {
    const a = this.anchor!;
    const dt = Math.min(MAX_PREDICT_MS, Math.max(0, now - a.at)) / 1000;
    return travelled(a.fix.speed ?? 0, a.accel, dt);
  }

  /** The acceleration (m/s²) the estimate is currently using. */
  get accel(): number {
    return this.anchor?.accel ?? 0;
  }

  reset(): void {
    this.anchor = null;
    this.correction = null;
    this.speeds = [];
  }

  /** Where the estimate at `now` lies on the route or road (null if the last fix wasn't on one). */
  refAt(now = Date.now()): PathRef | null {
    const a = this.anchor;
    if (!a?.ref) return null;
    const meters = this.moved(now);
    return meters > 0 ? advance(a.ref, meters).ref : a.ref;
  }

  /** Estimated position at `now`, or null before the first fix. */
  predict(now = Date.now()): Fix | null {
    const a = this.anchor;
    if (!a) return null;
    const meters = this.moved(now);
    let pos: LatLon = a.fix;
    let heading = a.fix.heading;
    if (meters > 0 && a.ref) {
      const moved = advance(a.ref, meters);
      pos = pointOnPath(moved.ref);
      heading = bearingOnPath(moved.ref);
      if (moved.ended && moved.left > 0) pos = destination(pos, heading, moved.left);
    } else if (meters > 0 && heading != null) pos = destination(a.fix, heading, meters);

    const c = this.correction;
    if (c) {
      const k = 1 - (now - c.at) / CORRECTION_MS;
      if (k > 0) pos = { lat: pos.lat + c.dLat * k, lon: pos.lon + c.dLon * k };
      else this.correction = null;
    }
    return { ...a.fix, lat: pos.lat, lon: pos.lon, heading, ts: now };
  }
}
