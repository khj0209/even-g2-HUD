import { describe, expect, it } from 'vitest';
import { distance } from '../src/core/geo';
import type { Fix } from '../src/core/types';
import { matchToPaths } from '../src/services/matching';
import { routeFromPolyline, RouteTracker } from '../src/services/routing';
import { LocationSmoother } from '../src/services/smoother';

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
