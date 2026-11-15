import { bearing, interpolate } from '../core/geo';
import type { Fix, LatLon } from '../core/types';
import type { RoadData } from './roads';
import { routeFromPolyline, type Route } from './routing';

/**
 * Self-contained demo drive: a made-up loop with its own speed limits, camera and route, so the
 * whole HUD can be exercised at a desk with no GPS and no network.
 */
const PATH: LatLon[] = [
  { lat: 37.498, lon: 127.0276 },
  { lat: 37.5043, lon: 127.0276 }, // 700 m north
  { lat: 37.5043, lon: 127.0389 }, // right, 1 km east
  { lat: 37.4989, lon: 127.0389 }, // right, 600 m south
  { lat: 37.4975, lon: 127.0371 }, // slight right
  { lat: 37.4975, lon: 127.0299 }, // 640 m west
];
const NAMES = ['테헤란로', '언주로', '도곡로', '역삼로'];
/** Limit (km/h) and how fast the demo car drives (km/h) on each leg — it speeds on leg 2 and 4. */
const LEGS = [
  { limit: 50, speed: 46 },
  { limit: 60, speed: 71 },
  { limit: 30, speed: 28 },
  { limit: 50, speed: 44 },
  { limit: 50, speed: 58 },
];

export const demoRoute = (): Route => routeFromPolyline(PATH, NAMES, 13);

export const demoRoadData = (): RoadData => ({
  ways: LEGS.map((leg, i) => ({ maxspeed: leg.limit, points: [PATH[i], PATH[i + 1]] })),
  cameras: [{ ...interpolate(PATH[1], PATH[2], 0.7), maxspeed: 60 }],
});

/** Position on the demo drive `elapsed` seconds in. Stops at the end. */
export function demoFix(elapsed: number, ts: number): Fix {
  const route = demoRoute();
  let t = elapsed;
  for (let i = 0; i < LEGS.length; i++) {
    const len = route.cum[i + 1] - route.cum[i];
    const mps = LEGS[i].speed / 3.6;
    const legTime = len / mps;
    if (t < legTime) {
      // Ease in/out of each corner so the speed readout moves like a real car.
      const edge = Math.min(t, legTime - t);
      const speed = mps * Math.min(1, 0.45 + edge / 6);
      return { ...interpolate(PATH[i], PATH[i + 1], t / legTime), speed, heading: bearing(PATH[i], PATH[i + 1]), ts };
    }
    t -= legTime;
  }
  return { ...PATH[PATH.length - 1], speed: 0, heading: null, ts };
}
