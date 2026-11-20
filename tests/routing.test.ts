import { describe, expect, it } from 'vitest';
import { demoFix, demoRoadData, demoRoute } from '../src/services/demo';
import { matchLimit } from '../src/services/roads';
import { osrmToRoute, routeFromPolyline, RouteTracker, searchPlaces, tmapToRoute, transferTraffic } from '../src/services/routing';

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

describe('tmapToRoute', () => {
  const point = (p: { lat: number; lon: number }, props: Record<string, unknown>) => ({
    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    properties: props,
  });
  const line = (pts: { lat: number; lon: number }[], props: Record<string, unknown>) => ({
    geometry: { type: 'LineString', coordinates: pts.map((p) => [p.lon, p.lat]) },
    properties: props,
  });
  const json = {
    features: [
      point(L[0], { turnType: 200, totalTime: 200 }),
      line([L[0], L[1]], { name: 'A로' }),
      point(L[1], { turnType: 13, description: '우회전' }),
      line([L[1], L[2]], { name: 'C로' }),
      point(L[2], { turnType: 201 }),
    ],
  };

  it('keeps real manoeuvres, names them from the following segment, and totals distance/duration', () => {
    const route = tmapToRoute(json);
    expect(route.steps.map((s) => [s.icon, s.name])).toEqual([
      ['right', 'C로'],
      ['arrive', ''],
    ]);
    expect(route.steps[0].at).toBeCloseTo(1112, -1);
    expect(route.distance).toBeCloseTo(1994, 0);
    expect(route.duration).toBe(200);
  });

  it('drops turn codes it does not recognise rather than guessing', () => {
    const route = tmapToRoute({
      features: [point(L[0], { turnType: 200 }), line([L[0], L[1]], { name: 'A로' }), point(L[1], { turnType: 11 })],
    });
    expect(route.steps).toEqual([]);
  });

  it('guides through expressway junctions, exits and rotaries, but not tunnels', () => {
    const turns = (turnType: number) =>
      tmapToRoute({
        features: [point(L[0], { turnType: 200 }), line([L[0], L[1]], { name: 'X' }), point(L[1], { turnType }), line([L[1], L[2]], { name: 'Y' })],
      }).steps.map((s) => s.icon);
    // Codes and meanings as seen in a real Tmap response: 117/118 "오른쪽/왼쪽 방향" at a JC,
    // 103 "전방 고속도로 입구", 104 "오른쪽 고속도로 출구", 121 "터널".
    expect(turns(117)).toEqual(['slight-right']);
    expect(turns(118)).toEqual(['slight-left']);
    expect(turns(103)).toEqual(['straight']);
    expect(turns(104)).toEqual(['slight-right']);
    expect(turns(135)).toEqual(['roundabout']);
    expect(turns(121)).toEqual([]);
  });

  it('throws when there is no route', () => {
    expect(() => tmapToRoute({ features: [] })).toThrow();
  });
});

describe('searchPlaces (Tmap)', () => {
  const respond = (status: number, body: string) => async () => new Response(status === 204 ? null : body, { status });

  it('treats 204 No Content as no results', async () => {
    expect(await searchPlaces('없는곳', null, 'key', respond(204, '') as typeof fetch)).toEqual([]);
  });

  it('reads POIs, preferring the entrance coordinates', async () => {
    const body = JSON.stringify({
      searchPoiInfo: { pois: { poi: [{ name: '강남역', frontLat: '37.49', frontLon: '127.02', noorLat: '37.5', noorLon: '127.03' }] } },
    });
    expect(await searchPlaces('강남역', null, 'key', respond(200, body) as typeof fetch)).toEqual([
      { name: '강남역', lat: 37.49, lon: 127.02 },
    ]);
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

describe('traffic', () => {
  const line = (pts: { lat: number; lon: number }[], traffic?: number[][]) => ({
    geometry: { type: 'LineString', coordinates: pts.map((p) => [p.lon, p.lat]), ...(traffic ? { traffic } : {}) },
    properties: {},
  });
  const A = { lat: 37.5, lon: 127 };
  const B = { lat: 37.505, lon: 127 };
  const C = { lat: 37.51, lon: 127 };
  const D = { lat: 37.51, lon: 127.01 };

  it('reads per-segment congestion from Tmap lines', () => {
    const r = tmapToRoute({
      features: [line([A, B, C], [[0, 1, 1, 50], [1, 2, 4, 5]]), line([C, D], [[0, 1, 3, 15]])],
    });
    // Points A B C C D: segments A–B free, B–C jammed, C–C (join) unknown, C–D heavy.
    expect(r.traffic!.slice(0, 4)).toEqual([1, 4, 0, 3]);
  });

  it('has no traffic when Tmap sent none', () => {
    expect(tmapToRoute({ features: [line([A, B])] }).traffic).toBeUndefined();
  });

  it('copies fresh congestion onto the current route where they overlap', () => {
    const current = routeFromPolyline([A, B, C, D]);
    const fresh = { ...routeFromPolyline([A, B, C]), traffic: [2, 4, 0] };
    expect(transferTraffic(current, fresh).traffic).toEqual([2, 4, 0]); // C–D not on the fresh route
  });
});
