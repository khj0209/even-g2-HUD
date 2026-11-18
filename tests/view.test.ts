import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Fix } from '../src/core/types';
import { buildView, LimitFilter, minimapScale, type HudInput } from '../src/hud/view';
import { FixNormalizer } from '../src/services/location';

const now = new Date(2026, 0, 1, 14, 5);
const fix = (kmh: number): Fix => ({ lat: 37.5, lon: 127, speed: kmh / 3.6, heading: 45, ts: now.getTime() });
const input = (over: Partial<HudInput> = {}): HudInput => ({
  fix: fix(63),
  limit: 60,
  camera: null,
  nav: null,
  route: null,
  settings: DEFAULT_SETTINGS,
  now,
  ...over,
});

describe('buildView', () => {
  it('shows speed, limit and overspeed', () => {
    const v = buildView(input());
    expect(v).toMatchObject({ speed: '63', unit: 'km/h', limit: 60, over: true, info: '14:05  NE', alert: '', nav: null });
  });

  it('respects the overspeed tolerance', () => {
    const settings = { ...DEFAULT_SETTINGS, overspeedTolerance: 5 };
    expect(buildView(input({ settings })).over).toBe(false);
    expect(buildView(input({ settings, fix: fix(66) })).over).toBe(true);
  });

  it('shows placeholders without GPS', () => {
    const v = buildView(input({ fix: null, limit: null }));
    expect(v).toMatchObject({ speed: '--', over: false, limit: null, info: '14:05  GPS 없음' });
  });

  it('converts to mph', () => {
    const v = buildView(input({ settings: { ...DEFAULT_SETTINGS, unit: 'mph' }, fix: fix(100), limit: 80 }));
    expect(v).toMatchObject({ speed: '62', unit: 'mph', limit: 50, over: true });
  });

  it('formats navigation and camera alerts', () => {
    const v = buildView(
      input({
        nav: { icon: 'left', distToManeuver: 337, roadName: '테헤란로', remainingDist: 12400, remainingTime: 27 * 60 },
        camera: { dist: 280, limit: 50 },
      }),
    );
    expect(v.nav).toEqual({ icon: 'left', dist: '350 m' });
    expect(v.info).toBe('테헤란로  12 km · 14:32 도착');
    expect(v.alert).toBe('단속 300 m');
  });

  it('falls back to the camera limit on roads with no tagged limit', () => {
    const v = buildView(input({ limit: null, camera: { dist: 280, limit: 50 } }));
    expect(v).toMatchObject({ limit: 50, over: true });
  });

  it('hides camera alerts when disabled', () => {
    const v = buildView(input({ camera: { dist: 280, limit: 50 }, settings: { ...DEFAULT_SETTINGS, cameraAlerts: false } }));
    expect(v.alert).toBe('');
  });
});

describe('buildView minimap', () => {
  const route = { points: [{ lat: 37.5, lon: 127 }, { lat: 37.5, lon: 127.0011327 }], cum: [0, 100], steps: [], distance: 100, duration: 10 };
  const eastbound = { lat: 37.5, lon: 127, speed: 10, heading: 90, ts: now.getTime() };

  it('rotates heading-up: a point dead ahead (east, facing east) ends up straight up on screen', () => {
    const v = buildView(input({ route, fix: eastbound }));
    expect(v.minimap?.headingKnown).toBe(true);
    expect(v.minimap?.route[0]).toMatchObject({ x: expect.closeTo(0, 5), y: expect.closeTo(0, 5) });
    expect(v.minimap?.route[1].x).toBeCloseTo(0, 0);
    expect(v.minimap?.route[1].y).toBeCloseTo(-33.3, 0); // 100 m at 3 m/px; negative y = ahead
    expect(v.minimap?.dest).toMatchObject({ x: expect.closeTo(0, 0), y: expect.closeTo(-33.3, 0) });
  });

  it('shows the map without a route, and nothing without a position', () => {
    const roads = {
      ways: [],
      // One building 40 m ahead, one far away.
      buildings: [
        [
          { lat: 37.4999, lon: 127.00045 },
          { lat: 37.4999, lon: 127.0005 },
          { lat: 37.5001, lon: 127.0005 },
          { lat: 37.4999, lon: 127.00045 },
        ],
        [
          { lat: 37.6, lon: 127.1 },
          { lat: 37.6, lon: 127.1001 },
          { lat: 37.6001, lon: 127.1001 },
          { lat: 37.6, lon: 127.1 },
        ],
      ],
      cameras: [{ lat: 37.5, lon: 127.0005, maxspeed: 50 }],
      map: [
        // North–south street crossing 50 m ahead, and one 5 km away that must be clipped out.
        { major: false, points: [{ lat: 37.499, lon: 127.000566 }, { lat: 37.501, lon: 127.000566 }] },
        { major: true, points: [{ lat: 37.55, lon: 127 }, { lat: 37.56, lon: 127 }] },
      ],
    };
    const v = buildView(input({ route: null, roads, fix: eastbound }));
    expect(v.minimap?.route).toEqual([]);
    expect(v.minimap?.roads).toHaveLength(1);
    expect(v.minimap?.roads[0].points[0].y).toBeCloseTo(-16.7, 0); // crosses 50 m ahead
    expect(v.minimap?.cameras).toHaveLength(1);
    expect(v.minimap?.buildings).toHaveLength(1);
    expect(buildView(input({ fix: null })).minimap).toBeNull();
  });

  it('marks the next turn', () => {
    const nav = { icon: 'left' as const, distToManeuver: 60, roadName: '', remainingDist: 100, remainingTime: 10 };
    const v = buildView(input({ route, nav, fix: eastbound }));
    expect(v.minimap?.turn).toMatchObject({ x: expect.closeTo(0, 0), y: expect.closeTo(-20, 0) });
  });

  it('keeps the redraw key steady through sub-pixel jitter but not real movement', () => {
    const key = (lat: number) => buildView(input({ route, fix: { ...eastbound, lat } })).minimap?.key;
    expect(key(37.500001)).toBe(key(37.5)); // ~10 cm
    expect(key(37.5001)).not.toBe(key(37.5)); // ~11 m
  });

  it('zooms out with speed', () => {
    expect([30, 70, 110].map(minimapScale)).toEqual([3, 4.5, 7]);
  });

  it('falls back to north-up and a plain marker without a heading', () => {
    const v = buildView(input({ route, fix: { lat: 37.5, lon: 127, speed: 0, heading: null, ts: now.getTime() } }));
    expect(v.minimap?.headingKnown).toBe(false);
  });

  it('still draws a line when both vertices of a long leg are farther than the box radius (demo-route regression)', () => {
    // A single 1000 m leg (like the demo drive's legs); car sits at its midpoint, 500 m from either end.
    const longLeg = { points: [{ lat: 37.5, lon: 127 }, { lat: 37.509, lon: 127 }], cum: [0, 1001], steps: [], distance: 1001, duration: 60 };
    const v = buildView(input({ route: longLeg, fix: { lat: 37.5045, lon: 127, speed: 10, heading: 0, ts: now.getTime() } }));
    expect(v.minimap?.route.length).toBeGreaterThanOrEqual(2);
  });
});

describe('LimitFilter', () => {
  it('needs two matching readings to change and five to clear', () => {
    const f = new LimitFilter();
    expect(f.next(50)).toBeNull();
    expect(f.next(50)).toBe(50);
    expect(f.next(30)).toBe(50); // one stray reading at a junction
    expect(f.next(50)).toBe(50);
    expect([null, null, null, null].map((v) => f.next(v))).toEqual([50, 50, 50, 50]);
    expect(f.next(null)).toBeNull();
  });
});

describe('FixNormalizer', () => {
  const T = Date.now();
  const at = (lat: number, ms: number, extra: Partial<Fix> = {}): Fix => ({ lat, lon: 127, speed: null, heading: null, ts: T + ms, ...extra });
  const M = 1 / 111195; // degrees of latitude per metre

  it('derives speed and heading from movement when the platform omits them', () => {
    const n = new FixNormalizer();
    n.next(at(37.5, 0));
    const f = n.next(at(37.5 + 11.1 * M, 1000))!;
    expect(f.speed).toBeCloseTo(11.1, 1);
    expect(f.heading).toBeCloseTo(0, 3);
  });

  it('ignores invalid values and keeps the last heading at standstill', () => {
    const n = new FixNormalizer();
    expect(n.next(at(37.5, 0, { speed: 10, heading: 90 }))!.heading).toBe(90);
    const stopped = n.next(at(37.5, 1000, { speed: 0.2, heading: 200 }))!;
    expect(stopped.heading).toBe(90);
    expect(n.next(at(37.5, 2000, { speed: -1, heading: -1 }))!.speed).toBe(0);
  });

  it('skips inaccurate fixes, duplicates and out-of-order fixes', () => {
    const n = new FixNormalizer();
    expect(n.next(at(37.5, 0, { accuracy: 120 }))).toBeNull();
    expect(n.next(at(37.5, 0, { accuracy: 8 }))).not.toBeNull();
    expect(n.next(at(37.5, 0))).toBeNull();
    expect(n.next(at(37.5, -500))).toBeNull();
  });

  it('rejects an impossible jump, but accepts the new place if it persists', () => {
    const n = new FixNormalizer();
    n.next(at(37.5, 0, { speed: 15 }));
    const far = 37.5 + 5000 * M; // 5 km in a second
    expect(n.next(at(far, 1000, { speed: 15 }))).toBeNull();
    expect(n.next(at(far, 2000, { speed: 15 }))).toBeNull();
    expect(n.next(at(far, 3000, { speed: 15 }))).toBeNull();
    expect(n.next(at(far, 4000, { speed: 15 }))).not.toBeNull();
  });

  it('smooths a one-off spike in platform speed', () => {
    const n = new FixNormalizer();
    let lat = 37.5;
    const step = (ms: number, mps: number) => n.next(at((lat += mps * M), ms, { speed: mps }))!.speed! * 3.6;
    step(0, 50 / 3.6);
    step(1000, 50 / 3.6);
    const spike = step(2000, 80 / 3.6);
    expect(spike).toBeGreaterThan(50);
    expect(spike).toBeLessThan(80); // pulled most of the way, not all the way
    expect(step(3000, 80 / 3.6)).toBeGreaterThan(spike); // and catches up quickly
  });

  it('holds the shown speed through sub-km/h jitter, and reads 0 when crawling', () => {
    const n = new FixNormalizer();
    let lat = 37.5;
    const step = (ms: number, kmh: number) => n.next(at((lat += 1e-6), ms, { speed: kmh / 3.6 }))!.speed! * 3.6;
    const first = step(0, 59.6);
    expect(step(1000, 60.0)).toBeCloseTo(first, 5);
    expect(step(2000, 59.7)).toBeCloseTo(first, 5);
    expect(step(3000, 2)).toBeLessThan(40); // big change goes through
    expect(step(10000, 1)).toBe(0);
  });

  it('accepts timestamps in seconds', () => {
    const n = new FixNormalizer();
    const f = n.next({ lat: 37.5, lon: 127, speed: 10, heading: 0, ts: Math.floor(T / 1000) });
    expect(Math.abs(f!.ts - T)).toBeLessThan(1500);
  });
});
