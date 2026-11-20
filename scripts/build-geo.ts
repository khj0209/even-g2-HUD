// Cuts coastlines, rivers and lakes out of an OpenStreetMap extract into coarse (~11 km) tiles of
// simplified lines, drawn faintly behind the route overview on the glasses.
//
//   node scripts/build-geo.ts geo.geojsonseq site
//
// Input: GeoJSON sequence from `osmium export` (see .github/workflows/map-tiles.yml).
// Output: site/geo/<x>/<y>.json, and geo counts merged into site/index.json if it exists.
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { encodeGeoTile, GEO_LAT, GEO_LON, simplify, splitByGrid, type GeoTile } from '../src/services/tileformat.ts';

type P = { lat: number; lon: number };
const [input, outDir] = process.argv.slice(2);
if (!input || !outDir) {
  console.error('usage: node scripts/build-geo.ts <geo.geojsonseq> <out dir>');
  process.exit(1);
}

/** Simplification tolerance (m): the overview shows tens of km in 140 px, ~100+ m per pixel. */
const TOL = 30;
/** Lakes smaller than this (m²) don't show at overview scale. */
const MIN_WATER_AREA = 300_000;

const tiles = new Map<string, GeoTile>();
const tile = (k: string) => {
  let t = tiles.get(k);
  if (!t) tiles.set(k, (t = { coast: [], rivers: [], water: [] }));
  return t;
};
const toPoints = (c: [number, number][]): P[] => c.map(([lon, lat]) => ({ lat, lon }));

function addLine(kind: 'coast' | 'rivers', pts: P[]): void {
  const s = simplify(pts, TOL);
  if (s.length < 2) return;
  for (const [k, runs] of splitByGrid(s, GEO_LAT, GEO_LON)) tile(k)[kind].push(...runs);
}

/** Area of a ring in m² (shoelace in a local flat projection). */
function area(pts: P[]): number {
  const kx = 111320 * Math.cos((pts[0].lat * Math.PI) / 180);
  let a = 0;
  for (let i = 0; i + 1 < pts.length; i++) a += pts[i].lon * kx * pts[i + 1].lat * 110540 - pts[i + 1].lon * kx * pts[i].lat * 110540;
  return Math.abs(a / 2);
}

/** Outlines stay whole (to fill them), in every tile their bounding box touches. */
function addWater(ring: P[]): void {
  if (ring.length < 4 || area(ring) < MIN_WATER_AREA) return;
  const s = simplify(ring, TOL);
  if (s.length < 4) return;
  const lats = s.map((p) => p.lat);
  const lons = s.map((p) => p.lon);
  for (let x = Math.floor(Math.min(...lats) / GEO_LAT); x <= Math.floor(Math.max(...lats) / GEO_LAT); x++)
    for (let y = Math.floor(Math.min(...lons) / GEO_LON); y <= Math.floor(Math.max(...lons) / GEO_LON); y++) tile(`${x}:${y}`).water.push(s);
}

const counts = { coast: 0, rivers: 0, water: 0 };
const lines = createInterface({ input: createReadStream(input), crlfDelay: Infinity });
for await (const raw of lines) {
  const line = raw.replace(/^\x1e/, '').trim();
  if (!line) continue;
  const f = JSON.parse(line);
  const g = f.geometry;
  const t = f.properties ?? {};
  if (!g) continue;
  const polygons: [number, number][][][] = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  if (t.natural === 'coastline') {
    // Islands come out as closed ways, which osmium may export as polygons.
    if (g.type === 'LineString') addLine('coast', toPoints(g.coordinates));
    for (const poly of polygons) addLine('coast', toPoints(poly[0]));
    counts.coast++;
  } else if (t.waterway === 'river' && g.type === 'LineString') {
    addLine('rivers', toPoints(g.coordinates));
    counts.rivers++;
  } else if ((t.natural === 'water' || t.waterway === 'riverbank') && polygons.length) {
    for (const poly of polygons) addWater(toPoints(poly[0]));
    counts.water++;
  }
}

let bytes = 0;
for (const [key, g] of tiles) {
  const [x, y] = key.split(':');
  mkdirSync(`${outDir}/geo/${x}`, { recursive: true });
  const json = encodeGeoTile(g);
  bytes += json.length;
  writeFileSync(`${outDir}/geo/${x}/${y}.json`, json);
}
const indexFile = `${outDir}/index.json`;
if (existsSync(indexFile)) {
  const index = JSON.parse(readFileSync(indexFile, 'utf8'));
  writeFileSync(indexFile, JSON.stringify({ ...index, geo: { tiles: tiles.size, ...counts } }));
}
console.log(`geo: ${counts.coast} coastline, ${counts.rivers} river, ${counts.water} water features → ${tiles.size} tiles, ${(bytes / 1e6).toFixed(1)} MB`);
