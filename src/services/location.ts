import { AppLocationAccuracy, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { bearing, distance } from '../core/geo';
import type { Fix } from '../core/types';
import { demoFix } from './demo';

export interface LocationSource {
  start(onFix: (fix: Fix) => void): void;
  stop(): void;
}

const valid = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/**
 * Fills in speed/heading when the platform does not report them, by differencing fixes.
 * Heading is only trusted while moving; at standstill the last heading is kept.
 */
export class FixNormalizer {
  private prev: Fix | null = null;
  private heading: number | null = null;

  next(raw: Fix): Fix {
    const prev = this.prev;
    let speed = valid(raw.speed) ? raw.speed : null;
    let heading = valid(raw.heading) ? raw.heading : null;
    if (prev && raw.ts > prev.ts) {
      const d = distance(prev, raw);
      if (speed == null) speed = d / ((raw.ts - prev.ts) / 1000);
      if (heading == null && d > 3) heading = bearing(prev, raw);
    }
    if (speed != null && speed < 1.5) heading = null; // GPS course is noise when crawling
    if (heading != null) this.heading = heading;
    this.prev = raw;
    return { ...raw, speed, heading: this.heading };
  }
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
      { enableHighAccuracy: true, maximumAge: 1000 },
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
      .startAppLocationUpdates({ accuracy: AppLocationAccuracy.High, intervalMs: 1000, distanceFilter: 0 })
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
      onFix(fix);
    };
    tick();
    this.timer = setInterval(tick, 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
