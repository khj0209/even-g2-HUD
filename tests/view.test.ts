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
    expect(v.minimap?.route[1].y).toBeCloseTo(-50, 0); // 100 m at 2 m/px; negative y = ahead
    expect(v.minimap?.dest).toMatchObject({ x: expect.closeTo(0, 0), y: expect.closeTo(-50, 0) });
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
    expect(v.minimap?.roads[0].points[0].y).toBeCloseTo(-25, 0); // crosses 50 m ahead
    expect(v.minimap?.cameras).toHaveLength(1);
    expect(v.minimap?.buildings).toHaveLength(1);
    expect(buildView(input({ fix: null })).minimap).toBeNull();
  });

  it('marks the next turn', () => {
    const nav = { icon: 'left' as const, distToManeuver: 60, roadName: '', remainingDist: 100, remainingTime: 10 };
    const v = buildView(input({ route, nav, fix: eastbound }));
    expect(v.minimap?.turn).toMatchObject({ x: expect.closeTo(0, 0), y: expect.closeTo(-30, 0) });
  });

  it('keeps the redraw key steady through sub-pixel jitter but not real movement', () => {
    const key = (lat: number) => buildView(input({ route, fix: { ...eastbound, lat } })).minimap?.key;
    expect(key(37.500001)).toBe(key(37.5)); // ~10 cm
    expect(key(37.5001)).not.toBe(key(37.5)); // ~11 m
  });

  it('zooms out with speed', () => {
    expect([30, 70, 110].map(minimapScale)).toEqual([2, 3, 5]);
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
  it('derives speed and heading from movement when the platform omits them', () => {
    const n = new FixNormalizer();
    n.next({ lat: 37.5, lon: 127, speed: null, heading: null, ts: 0 });
    const f = n.next({ lat: 37.5001, lon: 127, speed: null, heading: null, ts: 1000 });
    expect(f.speed).toBeCloseTo(11.1, 1);
    expect(f.heading).toBeCloseTo(0, 3);
  });

  it('ignores invalid values and keeps the last heading at standstill', () => {
    const n = new FixNormalizer();
    expect(n.next({ lat: 37.5, lon: 127, speed: 10, heading: 90, ts: 0 }).heading).toBe(90);
    const stopped = n.next({ lat: 37.5, lon: 127, speed: 0.2, heading: 200, ts: 1000 });
    expect(stopped.heading).toBe(90);
    expect(n.next({ lat: 37.5, lon: 127, speed: -1, heading: -1, ts: 2000 }).speed).toBe(0);
  });
});
