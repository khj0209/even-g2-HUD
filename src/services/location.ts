import { AppLocationAccuracy, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { bearing, distance } from '../core/geo';
import type { Fix } from '../core/types';
import { demoFix, inDemoTunnel } from './demo';

export interface LocationSource {
  start(onFix: (fix: Fix) => void): void;
  stop(): void;
}

const valid = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/** Fixes worse than this (metres, 1σ) are skipped: in tunnels and urban canyons they jump around. */
const MAX_ACCURACY = 50;
/** A jump implying more than this (m/s, ~250 km/h) is a glitch, not driving. */
const MAX_PLAUSIBLE_SPEED = 70;
/** After this many rejected jumps in a row, accept the new place (e.g. leaving a long tunnel). */
const MAX_REJECTS = 3;
/** Window for deriving speed from positions when the platform gives none. */
const DERIVE_WINDOW_MS = 3000;
/** Below this the car is treated as stopped: GPS drifts a few km/h when standing still. */
const STOPPED_KMH = 3;
/** The shown speed only moves once the measurement differs by this much, so 59/60 doesn't flicker. */
const HYSTERESIS_KMH = 0.7;

/**
 * Cleans up raw position fixes for the HUD:
 * - drops duplicates, out-of-order fixes, inaccurate fixes and impossible jumps,
 * - fills in speed/heading when the platform does not report them (speed over a short window,
 *   which is far steadier than differencing two 1 s fixes),
 * - smooths speed lightly and holds the shown value steady through GPS jitter.
 * Heading is only trusted while moving; at standstill the last heading is kept.
 */
export class FixNormalizer {
  private history: Fix[] = [];
  private heading: number | null = null;
  private smoothed: number | null = null;
  private shownKmh: number | null = null;
  private rejects = 0;

  /** The cleaned fix, or null if this one should be ignored. */
  next(input: Fix): Fix | null {
    const raw = { ...input, ts: normalizeTimestamp(input.ts) };
    if (raw.accuracy != null && raw.accuracy > MAX_ACCURACY) return null;
    const prev = this.history[this.history.length - 1];
    if (prev && raw.ts <= prev.ts) return null;
    if (prev) {
      const implied = distance(prev, raw) / ((raw.ts - prev.ts) / 1000);
      if (implied > MAX_PLAUSIBLE_SPEED && ++this.rejects <= MAX_REJECTS) return null;
      if (implied > MAX_PLAUSIBLE_SPEED) this.history = []; // accepted relocation: start over
    }
    this.rejects = 0;

    const platformSpeed = valid(raw.speed) ? raw.speed : null;
    let speed = platformSpeed;
    let heading = valid(raw.heading) ? raw.heading : null;
    const base = this.history.find((f) => raw.ts - f.ts <= DERIVE_WINDOW_MS) ?? prev;
    if (base && base !== raw) {
      const d = distance(base, raw);
      if (speed == null) speed = d / ((raw.ts - base.ts) / 1000);
      if (heading == null && d > 3) heading = bearing(base, raw);
    }
    this.history = [...this.history.filter((f) => raw.ts - f.ts <= DERIVE_WINDOW_MS), raw];

    // GPS course is noise when crawling. Judge that on the measured speed, not the smoothed one,
    // which lags behind for a moment after stopping.
    if (speed != null && speed < 1.5) heading = null;
    if (speed != null) speed = this.smooth(speed, raw.ts - (prev?.ts ?? raw.ts), platformSpeed != null);
    if (heading != null) this.heading = heading;
    return { ...raw, speed, heading: this.heading };
  }

  /**
   * Light exponential smoothing (time constant 0.5 s for Doppler speed from the platform, which is
   * already clean, 1.2 s for speed derived from positions), then hysteresis on the shown value.
   */
  private smooth(mps: number, dtMs: number, fromPlatform: boolean): number {
    const tau = fromPlatform ? 500 : 1200;
    const alpha = this.smoothed == null || dtMs <= 0 ? 1 : 1 - Math.exp(-dtMs / tau);
    this.smoothed = this.smoothed == null ? mps : this.smoothed + alpha * (mps - this.smoothed);
    let kmh = this.smoothed * 3.6;
    if (kmh < STOPPED_KMH) kmh = 0;
    if (this.shownKmh == null || kmh === 0 || Math.abs(kmh - this.shownKmh) >= HYSTERESIS_KMH) this.shownKmh = kmh;
    return this.shownKmh / 3.6;
  }
}

/** Some hosts report seconds instead of milliseconds, or a skewed clock; staleness needs ms on our clock. */
function normalizeTimestamp(ts: number): number {
  const now = Date.now();
  const ms = ts > 0 && ts < 1e12 ? ts * 1000 : ts;
  return Number.isFinite(ms) && Math.abs(ms - now) < 30000 ? ms : now;
}

/** Plain browser geolocation, for running the page outside the Even App. */
export class BrowserLocationSource implements LocationSource {
  private watch: number | null = null;

  start(onFix: (fix: Fix) => void): void {
    if (!navigator.geolocation) return;
    this.watch = navigator.geolocation.watchPosition(
      (p) =>
        onFix({
          lat: p.coords.latitude,
          lon: p.coords.longitude,
          speed: p.coords.speed,
          heading: p.coords.heading,
          accuracy: p.coords.accuracy,
          ts: p.timestamp,
        }),
      (e) => console.warn('[location]', e.message),
      { enableHighAccuracy: true, maximumAge: 0 },
    );
  }

  stop(): void {
    if (this.watch != null) navigator.geolocation.clearWatch(this.watch);
    this.watch = null;
  }
}

/**
 * Phone GPS through the Even App (keeps working with the WebView in the background).
 * Falls back to browser geolocation where the host lacks the location API (e.g. the simulator).
 */
export class BridgeLocationSource implements LocationSource {
  private off: (() => void) | null = null;
  private fallback: BrowserLocationSource | null = null;
  constructor(private bridge: EvenAppBridge) {}

  start(onFix: (fix: Fix) => void): void {
    this.off = this.bridge.onAppLocationChanged((l) =>
      onFix({
        lat: l.latitude,
        lon: l.longitude,
        speed: l.speed ?? null,
        heading: l.heading ?? null,
        accuracy: l.accuracy,
        ts: l.timestamp ?? Date.now(),
      }),
    );
    this.bridge
      .startAppLocationUpdates({ accuracy: AppLocationAccuracy.High, intervalMs: 500, distanceFilter: 0 })
      .catch(() => false)
      .then((ok) => {
        if (ok || !this.off) return;
        console.warn('[location] Even App location unavailable, using browser geolocation');
        this.fallback = new BrowserLocationSource();
        this.fallback.start(onFix);
      });
  }

  stop(): void {
    this.off?.();
    this.off = null;
    this.fallback?.stop();
    this.fallback = null;
    void this.bridge.stopAppLocationUpdates().catch(() => false);
  }
}

/** Replays the built-in demo drive at 1 Hz, looping. */
export class DemoLocationSource implements LocationSource {
  private timer: ReturnType<typeof setInterval> | null = null;

  start(onFix: (fix: Fix) => void): void {
    let t = 0;
    const tick = () => {
      const fix = demoFix(t++, Date.now());
      if (fix.speed === 0 && t > 5) t = 0;
      if (!inDemoTunnel(fix)) onFix(fix); // no GPS in the tunnel
    };
    tick();
    this.timer = setInterval(tick, 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
