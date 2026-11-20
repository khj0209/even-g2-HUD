import { destination, distance } from '../core/geo';
import type { Fix, LatLon } from '../core/types';
import { advance, bearingOnPath, pointOnPath, type PathRef } from './matching';

/** Predict at most this far past the last fix; beyond it dead reckoning (matching.ts) takes over. */
const MAX_PREDICT_MS = 2500;
/** A new fix's disagreement with the prediction is blended away over this long, not jumped. */
const CORRECTION_MS = 500;
/** Disagreements larger than this are real (a re-route, a GPS reset) and taken at once. */
const MAX_CORRECTION_M = 30;

/**
 * Fills in positions between GPS fixes (about one a second) for a 10 Hz estimate: the car is
 * carried on from the last fix at its speed, along the route while guiding (so it turns where the
 * route turns), along the matched road otherwise, or straight along its heading. When the next fix
 * arrives, the difference from the estimate is faded out over half a second, so distances counting
 * down to a turn or a camera don't jump back.
 */
export class LocationSmoother {
  private anchor: { fix: Fix; ref: PathRef | null; at: number } | null = null;
  private correction: { dLat: number; dLon: number; at: number } | null = null;

  /** A new (cleaned, map-matched) fix. `ref`: where it lies on the route or road, if known. */
  update(fix: Fix, ref: PathRef | null, now = Date.now()): void {
    const predicted = this.anchor ? this.predict(now) : null;
    this.correction =
      predicted && distance(predicted, fix) < MAX_CORRECTION_M
        ? { dLat: predicted.lat - fix.lat, dLon: predicted.lon - fix.lon, at: now }
        : null;
    this.anchor = { fix, ref, at: now };
  }

  reset(): void {
    this.anchor = null;
    this.correction = null;
  }

  /** Where the estimate at `now` lies on the route or road (null if the last fix wasn't on one). */
  refAt(now = Date.now()): PathRef | null {
    const a = this.anchor;
    if (!a?.ref) return null;
    const dt = Math.min(MAX_PREDICT_MS, Math.max(0, now - a.at)) / 1000;
    const meters = (a.fix.speed ?? 0) * dt;
    return meters > 0 ? advance(a.ref, meters).ref : a.ref;
  }

  /** Estimated position at `now`, or null before the first fix. */
  predict(now = Date.now()): Fix | null {
    const a = this.anchor;
    if (!a) return null;
    const dt = Math.min(MAX_PREDICT_MS, Math.max(0, now - a.at)) / 1000;
    const meters = (a.fix.speed ?? 0) * dt;
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
