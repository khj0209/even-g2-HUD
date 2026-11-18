// Shared by the app and the tile build script (scripts/build-tiles.ts), which Node runs directly,
// so this file must not import anything at runtime.
import type { LatLon } from '../core/types';

/** Tiles of about 1.1 × 1.1 km in Korea. */
export const TILE_LAT = 0.01;
export const TILE_LON = 0.0125;

export interface Tile {
  /** Row (latitude) index. */
  x: number;
  /** Column (longitude) index. */
  y: number;
}

export const tileOf = (p: LatLon): Tile => ({ x: Math.floor(p.lat / TILE_LAT), y: Math.floor(p.lon / TILE_LON) });

export const DRIVABLE = /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)(_link)?$/;
export const MAJOR = /^(motorway|trunk|primary|secondary)(_link)?$/;

/** OSM maxspeed tag → km/h. Handles "50", "50 km/h", "30 mph"; anything else (e.g. "signals") is null. */
export function parseMaxspeed(tag: string | undefined): number | null {
  if (!tag) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?\s*$/i.exec(tag);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return Math.round(m[2]?.toLowerCase() === 'mph' ? v * 1.609344 : v);
}

/** What the HUD needs from a way's tags. Null if the way is of no use (not drivable, no limit). */
export function classify(tags: Record<string, unknown>): { drivable: boolean; major: boolean; maxspeed: number } | null {
  const highway = String(tags.highway ?? '');
  if (!highway) return null;
  const drivable = DRIVABLE.test(highway);
  const maxspeed = parseMaxspeed(tags.maxspeed as string | undefined) ?? 0;
  if (!drivable && !maxspeed) return null;
  return { drivable, major: MAJOR.test(highway), maxspeed };
}

/**
 * Cut a polyline into the pieces that fall in each tile (a piece keeps the segment that crosses the
 * border, so pieces from neighbouring tiles join up). Keyed "x:y".
 */
export function splitByTile(points: LatLon[]): Map<string, LatLon[][]> {
  const segsByTile = new Map<string, number[]>();
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    // Sample the segment finely enough (≤ ~1/4 tile) that no tile it passes through is missed.
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b.lat - a.lat) / (TILE_LAT / 4), Math.abs(b.lon - a.lon) / (TILE_LON / 4))));
    const keys = new Set<string>();
    for (let s = 0; s <= steps; s++) {
      const t = tileOf({ lat: a.lat + ((b.lat - a.lat) * s) / steps, lon: a.lon + ((b.lon - a.lon) * s) / steps });
      keys.add(`${t.x}:${t.y}`);
    }
    for (const k of keys) {
      const list = segsByTile.get(k);
      if (list) list.push(i);
      else segsByTile.set(k, [i]);
    }
  }
  const out = new Map<string, LatLon[][]>();
  for (const [k, segs] of segsByTile) {
    const runs: LatLon[][] = [];
    let start = segs[0];
    for (let j = 1; j <= segs.length; j++) {
      if (j < segs.length && segs[j] === segs[j - 1] + 1) continue;
      runs.push(points.slice(start, segs[j - 1] + 2));
      if (j < segs.length) start = segs[j];
    }
    out.set(k, runs);
  }
  return out;
}

const SCALE = 1e5; // ~1 m

/** Polyline → [lat0, lon0, dlat1, dlon1, …] in 1e-5 degree integers. */
function encodePoints(points: LatLon[]): number[] {
  const out: number[] = [];
  let pl = 0;
  let po = 0;
  for (const p of points) {
    const l = Math.round(p.lat * SCALE);
    const o = Math.round(p.lon * SCALE);
    out.push(l - pl, o - po);
    pl = l;
    po = o;
  }
  return out;
}

function decodePoints(a: number[]): LatLon[] {
  const out: LatLon[] = [];
  let l = 0;
  let o = 0;
  for (let i = 0; i + 1 < a.length; i += 2) {
    l += a[i];
    o += a[i + 1];
    out.push({ lat: l / SCALE, lon: o / SCALE });
  }
  return out;
}

export interface BundledWay {
  drivable: boolean;
  major: boolean;
  /** km/h, 0 if not tagged. */
  maxspeed: number;
  points: LatLon[];
}

export interface BundledCamera extends LatLon {
  maxspeed: number | null;
}

/**
 * Compact tile file: {"w": [[flags, maxspeed, points…], …], "c": [[lat, lon, maxspeed], …]}
 * flags: 1 = drivable, 2 = major road.
 */
export const encodeWay = (w: BundledWay) => [(w.drivable ? 1 : 0) | (w.major ? 2 : 0), w.maxspeed, encodePoints(w.points)];
export const encodeCamera = (c: BundledCamera) => [Math.round(c.lat * SCALE), Math.round(c.lon * SCALE), c.maxspeed ?? 0];

export function encodeTile(ways: BundledWay[], cameras: BundledCamera[]): string {
  return JSON.stringify({ w: ways.map(encodeWay), c: cameras.map(encodeCamera) });
}

export function decodeTile(json: any): { ways: BundledWay[]; cameras: BundledCamera[] } {
  const ways: BundledWay[] = (json?.w ?? []).map(([f, s, p]: [number, number, number[]]) => ({
    drivable: (f & 1) !== 0,
    major: (f & 2) !== 0,
    maxspeed: s,
    points: decodePoints(p),
  }));
  const cameras: BundledCamera[] = (json?.c ?? []).map(([l, o, s]: number[]) => ({ lat: l / SCALE, lon: o / SCALE, maxspeed: s || null }));
  return { ways, cameras };
}
