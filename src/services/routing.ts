import { angleDiff, bearing, distance, projectOnSegment } from '../core/geo';
import type { LatLon, ManeuverIcon, NavProgress } from '../core/types';

export interface Step {
  icon: ManeuverIcon;
  /** Road entered after the manoeuvre. */
  name: string;
  /** Metres from the route start to the manoeuvre point. */
  at: number;
}

export interface Route {
  points: LatLon[];
  /** Cumulative metres at each point. */
  cum: number[];
  steps: Step[];
  distance: number;
  /** Seconds. */
  duration: number;
}

export interface Place extends LatLon {
  name: string;
}

function cumulative(points: LatLon[]): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + distance(points[i - 1], points[i]));
  return cum;
}

const MODIFIER_ICON: Record<string, ManeuverIcon> = {
  uturn: 'uturn',
  'sharp left': 'sharp-left',
  left: 'left',
  'slight left': 'slight-left',
  straight: 'straight',
  'slight right': 'slight-right',
  right: 'right',
  'sharp right': 'sharp-right',
};

/** Convert an OSRM `/route` response (steps=true, geometries=geojson, overview=full). */
export function osrmToRoute(json: any): Route {
  const r = json?.routes?.[0];
  if (!r) throw new Error(json?.message || '경로를 찾을 수 없습니다');
  const points: LatLon[] = r.geometry.coordinates.map(([lon, lat]: [number, number]) => ({ lat, lon }));
  const steps: Step[] = [];
  let at = 0;
  for (const leg of r.legs)
    for (const s of leg.steps) {
      const { type, modifier } = s.maneuver;
      let icon: ManeuverIcon | null;
      if (type === 'depart') icon = null;
      else if (type === 'arrive') icon = 'arrive';
      else if (type === 'roundabout' || type === 'rotary') icon = 'roundabout';
      else {
        icon = MODIFIER_ICON[modifier] ?? 'straight';
        // "Road changes name, keep going straight" is noise on a HUD.
        if (icon === 'straight' && (type === 'new name' || type === 'continue')) icon = null;
      }
      if (icon) steps.push({ icon, name: s.name || s.ref || '', at });
      at += s.distance;
    }
  // Step distances are measured on OSRM's geometry; rescale onto ours so they line up.
  const cum = cumulative(points);
  const total = cum[cum.length - 1];
  const k = at > 0 ? total / at : 1;
  for (const s of steps) s.at *= k;
  return { points, cum, steps, distance: total, duration: r.duration };
}

/** Build a route from a bare polyline, deriving turns from the corner angles (used by demo mode). */
export function routeFromPolyline(points: LatLon[], names: string[] = [], speedMps = 12): Route {
  const cum = cumulative(points);
  const steps: Step[] = [];
  for (let i = 1; i + 1 < points.length; i++) {
    const turn = angleDiff(bearing(points[i - 1], points[i]), bearing(points[i], points[i + 1]));
    const mag = Math.abs(turn);
    if (mag < 20) continue;
    const side = turn > 0 ? 'right' : 'left';
    const icon: ManeuverIcon = mag > 160 ? 'uturn' : mag > 120 ? `sharp-${side}` : mag > 50 ? side : `slight-${side}`;
    steps.push({ icon, name: names[steps.length] ?? '', at: cum[i] });
  }
  const total = cum[cum.length - 1];
  steps.push({ icon: 'arrive', name: '', at: total });
  return { points, cum, steps, distance: total, duration: total / speedMps };
}

export type TrackResult =
  | { state: 'guiding'; progress: NavProgress }
  | { state: 'off-route' }
  | { state: 'arrived' };

const OFF_ROUTE_DIST = 60;
const OFF_ROUTE_FIXES = 4;
const ARRIVE_DIST = 30;

/** Follows the car along a route and reports the next manoeuvre. */
export class RouteTracker {
  private seg = 0;
  private offCount = 0;

  constructor(readonly route: Route) {}

  update(pos: LatLon): TrackResult {
    const { points, cum, steps, distance: total, duration } = this.route;
    // Look a little behind and well ahead of the last matched segment; fall back to the whole route.
    let best = this.nearest(pos, Math.max(0, this.seg - 2), Math.min(points.length - 1, this.seg + 40));
    if (best.dist > OFF_ROUTE_DIST) best = this.nearest(pos, 0, points.length - 1);

    if (best.dist > OFF_ROUTE_DIST) {
      if (++this.offCount >= OFF_ROUTE_FIXES) return { state: 'off-route' };
    } else {
      this.offCount = 0;
      this.seg = best.seg;
    }

    const travelled = cum[best.seg] + best.t * (cum[best.seg + 1] - cum[best.seg]);
    const remainingDist = Math.max(0, total - travelled);
    if (remainingDist < ARRIVE_DIST && best.dist <= OFF_ROUTE_DIST) return { state: 'arrived' };

    const next = steps.find((s) => s.at > travelled + 5) ?? steps[steps.length - 1];
    return {
      state: 'guiding',
      progress: {
        icon: next.icon,
        distToManeuver: Math.max(0, next.at - travelled),
        roadName: next.name,
        remainingDist,
        remainingTime: total > 0 ? (duration * remainingDist) / total : 0,
      },
    };
  }

  private nearest(pos: LatLon, from: number, to: number) {
    const { points } = this.route;
    let best = { dist: Infinity, seg: from, t: 0 };
    for (let i = from; i < to; i++) {
      const p = projectOnSegment(pos, points[i], points[i + 1]);
      if (p.dist < best.dist) best = { dist: p.dist, seg: i, t: p.t };
    }
    return best;
  }
}

const OSRM_URL = 'https://router.project-osrm.org/route/v1/driving';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';

export async function fetchRoute(from: LatLon, to: LatLon, fetchFn: typeof fetch = fetch): Promise<Route> {
  const url = `${OSRM_URL}/${from.lon},${from.lat};${to.lon},${to.lat}?steps=true&overview=full&geometries=geojson`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`경로 서버 오류 (HTTP ${res.status})`);
  return osrmToRoute(await res.json());
}

/** Free-text destination search, biased towards (but not limited to) the area around `near`. */
export async function searchPlaces(query: string, near: LatLon | null, fetchFn: typeof fetch = fetch): Promise<Place[]> {
  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '6', 'accept-language': 'ko' });
  if (near) {
    const d = 0.5;
    params.set('viewbox', `${near.lon - d},${near.lat + d},${near.lon + d},${near.lat - d}`);
  }
  const res = await fetchFn(`${NOMINATIM_URL}?${params}`);
  if (!res.ok) throw new Error(`검색 서버 오류 (HTTP ${res.status})`);
  const json = await res.json();
  return (json as any[]).map((p) => ({ name: p.display_name, lat: parseFloat(p.lat), lon: parseFloat(p.lon) }));
}
