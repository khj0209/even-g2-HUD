import { describe, expect, it } from 'vitest';
import { distance } from '../src/core/geo';
import type { Fix } from '../src/core/types';
import { matchToPaths } from '../src/services/matching';
import { routeFromPolyline, RouteTracker } from '../src/services/routing';
import { LocationSmoother, speedTrend, travelled } from '../src/services/smoother';

const M = 1 / 111195;
const T = 1_000_000;
const fix = (lat: number, lon: number, heading: number | null, speed = 20): Fix => ({ lat, lon, heading, speed, ts: T });

// A route north 300 m, then east.
const route = routeFromPolyline([
  { lat: 37.5, lon: 127 },
  { lat: 37.5 + 300 * M, lon: 127 },
  { lat: 37.5 + 300 * M, lon: 127.01 },
]);

describe('LocationSmoother', () => {
  it('carries the car on at its speed and heading between fixes', () => {
    const s = new LocationSmoother();
    const f = fix(37.5, 127, 0);
    s.update(f, null, T);
    const p = s.predict(T + 500)!; // 20 m/s × 0.5 s
    expect(distance(p, f)).toBeCloseTo(10, 1);
    expect(p.lat).toBeGreaterThan(f.lat);
    expect(p.ts).toBe(T + 500);
  });

  it('follows the route round a corner while guiding', () => {
    const s = new LocationSmoother();
    const f = fix(37.5 + 290 * M, 127, 0); // 10 m before the corner
    s.update(f, matchToPaths(f, [route.points], 50), T);
    const p = s.predict(T + 1000)!; // 20 m on: 10 m north, then 10 m east
    expect(p.lat).toBeCloseTo(37.5 + 300 * M, 6);
    expect(p.lon).toBeGreaterThan(127);
    expect(p.heading).toBeCloseTo(90, 0);
  });

  it('stops predicting after 2.5 s (dead reckoning takes over)', () => {
    const s = new LocationSmoother();
    const f = fix(37.5, 127, 0);
    s.update(f, null, T);
    expect(distance(s.predict(T + 10000)!, f)).toBeCloseTo(50, 0);
  });

  it('fades in a new fix\'s disagreement instead of jumping back', () => {
    const s = new LocationSmoother();
    s.update(fix(37.5, 127, 0), null, T);
    // One second later the fix says the car is 5 m behind where it was estimated to be.
    const late = fix(37.5 + 15 * M, 127, 0);
    s.update(late, null, T + 1000);
    expect(s.predict(T + 1000)!.lat).toBeCloseTo(37.5 + 20 * M, 6); // starts where the estimate was
    expect(s.predict(T + 1600)!.lat).toBeCloseTo(late.lat + 12 * M, 6); // fully on the fix's track
  });

  it('does not move a stopped car, and has nothing before the first fix', () => {
    const s = new LocationSmoother();
    expect(s.predict(T)).toBeNull();
    const f = fix(37.5, 127, 0, 0);
    s.update(f, null, T);
    expect(distance(s.predict(T + 900)!, f)).toBe(0);
  });
});

describe('RouteTracker.progressAt', () => {
  it('reports guidance for an estimate without moving the tracker on', () => {
    const t = new RouteTracker(route);
    t.update({ lat: 37.5 + 100 * M, lon: 127 });
    expect(t.progressAt({ lat: 37.5 + 250 * M, lon: 127 })!.distToManeuver).toBeCloseTo(50, 0);
    expect(t.progressAt({ lat: 37.6, lon: 127.2 })).toBeNull(); // off the route: no side effects
    expect(t.update({ lat: 37.5 + 110 * M, lon: 127 }).state).toBe('guiding');
  });
});

describe('speed trend', () => {
  it('reads braking and speeding up from recent GPS speeds, clamped and noise-free', () => {
    expect(speedTrend([{ t: 0, v: 20 }, { t: 1000, v: 16 }])).toBeCloseTo(-4, 5);
    expect(speedTrend([{ t: 0, v: 10 }, { t: 1000, v: 12 }, { t: 2000, v: 14 }])).toBeCloseTo(2, 5);
    expect(speedTrend([{ t: 0, v: 20 }, { t: 1000, v: 20.2 }])).toBe(0); // GPS wobble
    expect(speedTrend([{ t: 0, v: 20 }, { t: 1000, v: 5 }])).toBe(-8); // glitch, clamped
    expect(speedTrend([{ t: 0, v: 20 }])).toBe(0);
  });

  it('covers less ground while braking, and stops at zero', () => {
    expect(travelled(16, -4, 0.5)).toBeCloseTo(7.5, 5);
    expect(travelled(2, -4, 1)).toBeCloseTo(0.5, 5); // stopped after 0.5 s
    expect(travelled(0, 2, 1)).toBeCloseTo(1, 5);
  });

  it('slows the estimate down when the car is braking', () => {
    const s = new LocationSmoother();
    s.update(fix(37.5, 127, 0, 20), null, T);
    const f = fix(37.5 + 18 * M, 127, 0, 16);
    s.update(f, null, T + 1000);
    expect(s.accel).toBeCloseTo(-4, 5);
    // Past the fade-in of the correction: 0.8 s at 16 m/s braking at 4 → 11.52 m, not 12.8.
    expect(distance(s.predict(T + 1800)!, f)).toBeCloseTo(11.52, 1);
  });

  it('forgets old speeds after a gap', () => {
    const s = new LocationSmoother();
    s.update(fix(37.5, 127, 0, 30), null, T);
    s.update(fix(37.5, 127, 0, 10), null, T + 10000);
    expect(s.accel).toBe(0);
  });
});
