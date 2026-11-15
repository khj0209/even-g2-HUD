import { describe, expect, it } from 'vitest';
import { demoFix, demoRoadData, demoRoute } from '../src/services/demo';
import { matchLimit } from '../src/services/roads';
import { osrmToRoute, routeFromPolyline, RouteTracker } from '../src/services/routing';

// North 1.1 km, then east 0.9 km.
const L = [
  { lat: 37.5, lon: 127.0 },
  { lat: 37.51, lon: 127.0 },
  { lat: 37.51, lon: 127.01 },
];

describe('routeFromPolyline', () => {
  it('derives turns from corner angles', () => {
    const route = routeFromPolyline(L, ['동쪽길']);
    expect(route.steps.map((s) => s.icon)).toEqual(['right', 'arrive']);
    expect(route.steps[0].name).toBe('동쪽길');
    expect(route.steps[0].at).toBeCloseTo(1112, 0);
    expect(route.distance).toBeCloseTo(1994, 0);
  });
});

describe('osrmToRoute', () => {
  const step = (type: string, modifier: string | undefined, name: string, distance: number) => ({
    maneuver: { type, modifier },
    name,
    distance,
  });
  const json = {
    routes: [
      {
        duration: 200,
        geometry: { coordinates: L.map((p) => [p.lon, p.lat]) },
        legs: [
          {
            steps: [
              step('depart', undefined, 'A로', 600),
              step('new name', 'straight', 'B로', 512),
              step('turn', 'right', 'C로', 882),
              step('arrive', undefined, '', 0),
            ],
          },
        ],
      },
    ],
  };

  it('keeps real manoeuvres and drops depart / straight renames', () => {
    const route = osrmToRoute(json);
    expect(route.steps.map((s) => [s.icon, s.name])).toEqual([
      ['right', 'C로'],
      ['arrive', ''],
    ]);
    expect(route.steps[0].at).toBeCloseTo(1112, -1);
    expect(route.points[0]).toEqual(L[0]);
  });

  it('throws when there is no route', () => {
    expect(() => osrmToRoute({ code: 'NoRoute', message: 'Impossible route' })).toThrow('Impossible route');
  });
});

describe('RouteTracker', () => {
  it('counts down to the turn, then to arrival', () => {
    const tracker = new RouteTracker(routeFromPolyline(L));
    const start = tracker.update({ lat: 37.501, lon: 127.0 });
    expect(start).toMatchObject({ state: 'guiding', progress: { icon: 'right' } });
    if (start.state !== 'guiding') throw new Error();
    expect(start.progress.distToManeuver).toBeCloseTo(1001, 0);
    expect(start.progress.remainingDist).toBeCloseTo(1883, 0);

    const afterTurn = tracker.update({ lat: 37.51, lon: 127.002 });
    expect(afterTurn).toMatchObject({ state: 'guiding', progress: { icon: 'arrive' } });

    expect(tracker.update({ lat: 37.51, lon: 127.0099 }).state).toBe('arrived');
  });

  it('reports off-route only after several consecutive misses', () => {
    const tracker = new RouteTracker(routeFromPolyline(L));
    const away = { lat: 37.505, lon: 127.01 };
    expect(tracker.update(away).state).toBe('guiding');
    expect(tracker.update(away).state).toBe('guiding');
    expect(tracker.update({ lat: 37.505, lon: 127.0 }).state).toBe('guiding'); // back on: resets
    for (let i = 0; i < 3; i++) expect(tracker.update(away).state).toBe('guiding');
    expect(tracker.update(away).state).toBe('off-route');
  });
});

describe('demo drive', () => {
  it('follows its own route with limits, speeding on some legs, and ends in arrival', () => {
    const tracker = new RouteTracker(demoRoute());
    const roads = demoRoadData();
    const icons = new Set<string>();
    let overspeed = 0;
    let arrived = false;
    for (let t = 0; t < 600 && !arrived; t++) {
      const fix = demoFix(t, t * 1000);
      const limit = matchLimit(roads, fix);
      if (limit != null && fix.speed! * 3.6 > limit) overspeed++;
      const r = tracker.update(fix);
      expect(r.state).not.toBe('off-route');
      if (r.state === 'guiding') icons.add(r.progress.icon);
      else arrived = true;
    }
    expect(arrived).toBe(true);
    expect(overspeed).toBeGreaterThan(10);
    expect([...icons]).toEqual(expect.arrayContaining(['right', 'slight-right', 'arrive']));
  });
});
