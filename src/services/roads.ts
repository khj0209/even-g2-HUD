import { angleDiff, bearing, distance, projectOnSegment } from '../core/geo';
import type { CameraAlert, Fix, LatLon } from '../core/types';

/** A road with a tagged speed limit (km/h). */
export interface RoadWay {
  maxspeed: number;
  points: LatLon[];
}

export interface Camera extends LatLon {
  maxspeed: number | null;
}

/** Any drivable road, for drawing the minimap. */
export interface MapWay {
  major: boolean;
  points: LatLon[];
}

export interface RoadData {
  /** Roads with a tagged limit, for speed-limit matching. */
  ways: RoadWay[];
  cameras: Camera[];
  /** All drivable roads around the car, for the minimap. */
  map: MapWay[];
  /** Building outlines around the car (closed polygons), for the minimap. */
  buildings: LatLon[][];
}

export const emptyRoadData = (): RoadData => ({ ways: [], cameras: [], map: [], buildings: [] });

const DRIVABLE = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)(_link)?$/;
const MAJOR = /^(motorway|trunk|primary|secondary)(_link)?$/;

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const WAY_RADIUS = 700;
const CAMERA_RADIUS = 2000;
/** Refetch once we have driven this far from the centre of the last query. */
const REFETCH_DIST = 400;

/** OSM maxspeed tag → km/h. Handles "50", "50 km/h", "30 mph"; anything else (e.g. "signals") is null. */
export function parseMaxspeed(tag: string | undefined): number | null {
  if (!tag) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?\s*$/i.exec(tag);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Math.round(m[2]?.toLowerCase() === 'mph' ? v * 1.609344 : v);
}

export function buildQuery(c: LatLon): string {
  const at = `${c.lat.toFixed(5)},${c.lon.toFixed(5)}`;
  return (
    `[out:json][timeout:10];(` +
    `way(around:${WAY_RADIUS},${at})[highway][maxspeed];` +
    `way(around:${WAY_RADIUS},${at})[highway~"${DRIVABLE.source}"];` +
    `node(around:${CAMERA_RADIUS},${at})[highway=speed_camera];` +
    `);out body geom;`
  );
}

const BUILDING_RADIUS = 300;
/** Buildings only matter at city speeds and change block by block, so they use a smaller area. */
const BUILDING_REFETCH_DIST = 150;
const BUILDING_MAX_KMH = 70;

/** Outlines only (`skel`: no tags), to keep the download small in dense areas. */
export function buildBuildingQuery(c: LatLon): string {
  return `[out:json][timeout:15];way(around:${BUILDING_RADIUS},${c.lat.toFixed(5)},${c.lon.toFixed(5)})[building];out skel geom;`;
}

export function parseBuildings(json: any): LatLon[][] {
  const out: LatLon[][] = [];
  for (const el of json?.elements ?? [])
    if (el.type === 'way' && Array.isArray(el.geometry) && el.geometry.length >= 3)
      out.push(el.geometry.map((g: any) => ({ lat: g.lat, lon: g.lon })));
  return out;
}

export function parseOverpass(json: any): RoadData {
  const data = emptyRoadData();
  for (const el of json?.elements ?? []) {
    if (el.type === 'way' && Array.isArray(el.geometry)) {
      const points: LatLon[] = el.geometry.map((g: any) => ({ lat: g.lat, lon: g.lon }));
      const maxspeed = parseMaxspeed(el.tags?.maxspeed);
      if (maxspeed) data.ways.push({ maxspeed, points });
      const highway = String(el.tags?.highway ?? '');
      if (DRIVABLE.test(highway)) data.map.push({ major: MAJOR.test(highway), points });
    } else if (el.type === 'node') {
      data.cameras.push({ lat: el.lat, lon: el.lon, maxspeed: parseMaxspeed(el.tags?.maxspeed) });
    }
  }
  return data;
}

const MATCH_DIST = 30;
const MATCH_ANGLE = 35;

/**
 * Speed limit of the road we are most likely on: the closest way within 30 m whose direction
 * agrees with our heading (either way along it). Without a heading, closest way wins.
 */
export function matchLimit(data: RoadData, fix: Fix): number | null {
  let best: { score: number; maxspeed: number } | null = null;
  for (const way of data.ways) {
    for (let i = 0; i + 1 < way.points.length; i++) {
      const a = way.points[i];
      const b = way.points[i + 1];
      const { dist } = projectOnSegment(fix, a, b);
      if (dist > MATCH_DIST) continue;
      let score = dist;
      if (fix.heading != null) {
        const off = Math.abs(angleDiff(fix.heading, bearing(a, b)));
        const along = Math.min(off, 180 - off);
        if (along > MATCH_ANGLE) continue;
        score += along / 3; // prefer well-aligned roads at junctions
      }
      if (!best || score < best.score) best = { score, maxspeed: way.maxspeed };
    }
  }
  return best?.maxspeed ?? null;
}

const CAMERA_ALERT_DIST = 600;
const CAMERA_CONE = 25;

/** Closest speed camera roughly straight ahead. Needs a heading, so nothing is reported at standstill. */
export function cameraAhead(data: RoadData, fix: Fix): CameraAlert | null {
  if (fix.heading == null) return null;
  let best: CameraAlert | null = null;
  for (const cam of data.cameras) {
    const dist = distance(fix, cam);
    if (dist > CAMERA_ALERT_DIST || dist < 15) continue;
    if (Math.abs(angleDiff(fix.heading, bearing(fix, cam))) > CAMERA_CONE) continue;
    if (!best || dist < best.dist) best = { dist, limit: cam.maxspeed };
  }
  return best;
}

/** Fetches one Overpass query for the area around the car, again whenever it has moved far enough. */
class AreaFetcher<T> {
  private center: LatLon | null = null;
  private busy = false;
  private retryAt = 0;
  /** For the phone page: what happened to the last request. */
  status: 'idle' | 'loading' | 'ok' | 'error' = 'idle';
  error = '';

  constructor(
    private name: string,
    private query: (c: LatLon) => string,
    private parse: (json: any) => T,
    private refetchDist: number,
    private onData: (data: T) => void,
    private fetchFn: typeof fetch,
  ) {}

  update(fix: Fix): void {
    if (this.busy || Date.now() < this.retryAt) return;
    if (this.center && distance(this.center, fix) < this.refetchDist) return;
    this.busy = true;
    if (this.status !== 'ok') this.status = 'loading';
    const center = { lat: fix.lat, lon: fix.lon };
    // Without a timeout a hung request would leave `busy` set forever and the data would never refresh.
    this.fetchFn(OVERPASS_URL, {
      signal: AbortSignal.timeout(20000),
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(this.query(center)),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`Overpass HTTP ${r.status}`);
        return r.json();
      })
      .then((json) => {
        this.onData(this.parse(json));
        this.center = center;
        this.status = 'ok';
        this.error = '';
      })
      .catch((e) => {
        console.warn(`[${this.name}]`, e);
        // Keep showing the last good data; just note that the refresh failed.
        if (this.status !== 'ok') this.status = 'error';
        this.error = e instanceof Error ? e.message : String(e);
        this.retryAt = Date.now() + 15000;
      })
      .finally(() => (this.busy = false));
  }
}

/**
 * Keeps map data for the area around the car, refetching from Overpass as it moves. Roads (limits,
 * cameras, minimap roads) and buildings are separate requests, so a slow or failed building
 * download never holds up the speed limit.
 */
export class RoadDataService {
  data: RoadData = emptyRoadData();
  private roads: AreaFetcher<RoadData>;
  private buildings: AreaFetcher<LatLon[][]>;

  constructor(fetchFn: typeof fetch = (...a) => fetch(...a)) {
    this.roads = new AreaFetcher('roads', buildQuery, parseOverpass, REFETCH_DIST, (d) => {
      this.data = { ...d, buildings: this.data.buildings };
    }, fetchFn);
    this.buildings = new AreaFetcher('buildings', buildBuildingQuery, parseBuildings, BUILDING_REFETCH_DIST, (b) => {
      this.data = { ...this.data, buildings: b };
    }, fetchFn);
  }

  /** One line for the phone page, e.g. "도로 120 · 건물 340", so missing map data can be diagnosed. */
  statusText(): string {
    const part = (label: string, f: { status: string; error: string }, count: number) =>
      f.status === 'ok'
        ? `${label} ${count}${f.error ? ' (갱신 오류)' : ''}`
        : f.status === 'loading'
          ? `${label} 받는 중`
          : f.status === 'error'
            ? `${label} 오류: ${f.error}`
            : `${label} 대기`;
    return [
      part('도로', this.roads, this.data.map.length),
      part('건물', this.buildings, this.data.buildings.length),
    ].join(' · ');
  }

  /** Call on every fix; cheap unless a refetch is due. */
  update(fix: Fix): void {
    this.roads.update(fix);
    if ((fix.speed ?? 0) * 3.6 < BUILDING_MAX_KMH) this.buildings.update(fix);
  }
}
