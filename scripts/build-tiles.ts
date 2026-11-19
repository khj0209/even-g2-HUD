// Cuts the roads, speed limits and speed cameras of an OpenStreetMap extract into the app's ~1.1 km
// tiles. Input: GeoJSON sequence from `osmium export` (see .github/workflows/map-tiles.yml).
//
//   node scripts/build-tiles.ts roads.geojsonseq site 2026-11-18 [cameras.json]
//
// cameras.json (from scripts/fetch-cameras.ts) holds the national speed camera dataset; when it is
// given and not empty it replaces OpenStreetMap's (much sparser) speed cameras.
//
// Output: site/index.json and site/v1/<x>/<y>.json for every tile that has anything in it.
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { classify, encodeCamera, encodeWay, parseMaxspeed, splitByTile, tileOf, type BundledCamera } from '../src/services/tileformat.ts';

const [input, outDir, built = new Date().toISOString().slice(0, 10), camerasFile] = process.argv.slice(2);
const official: BundledCamera[] = camerasFile && existsSync(camerasFile) ? JSON.parse(readFileSync(camerasFile, 'utf8')) : [];
if (!input || !outDir) {
  console.error('usage: node scripts/build-tiles.ts <roads.geojsonseq> <out dir> [built date]');
  process.exit(1);
}

const tiles = new Map<string, { w: unknown[]; c: unknown[] }>();
const tile = (key: string) => {
  let t = tiles.get(key);
  if (!t) tiles.set(key, (t = { w: [], c: [] }));
  return t;
};

let features = 0;
let ways = 0;
let cameras = 0;
const lines = createInterface({ input: createReadStream(input), crlfDelay: Infinity });
for await (const raw of lines) {
  const line = raw.replace(/^\x1e/, '').trim(); // tolerate RFC 8142 record separators
  if (!line) continue;
  features++;
  const f = JSON.parse(line);
  const g = f.geometry;
  const props = f.properties ?? {};
  if (g?.type === 'Point') {
    if (props.highway !== 'speed_camera' || official.length) continue;
    const [lon, lat] = g.coordinates;
    const t = tileOf({ lat, lon });
    tile(`${t.x}:${t.y}`).c.push(encodeCamera({ lat, lon, maxspeed: parseMaxspeed(props.maxspeed) }));
    cameras++;
  } else if (g?.type === 'LineString') {
    const cls = classify(props);
    if (!cls) continue;
    const points = g.coordinates.map(([lon, lat]: [number, number]) => ({ lat, lon }));
    for (const [key, runs] of splitByTile(points)) for (const run of runs) tile(key).w.push(encodeWay({ ...cls, points: run }));
    ways++;
  }
}

for (const cam of official) {
  const t = tileOf(cam);
  tile(`${t.x}:${t.y}`).c.push(encodeCamera(cam));
  cameras++;
}

let bytes = 0;
for (const [key, data] of tiles) {
  const [x, y] = key.split(':');
  mkdirSync(`${outDir}/v1/${x}`, { recursive: true });
  const json = JSON.stringify(data);
  bytes += json.length;
  writeFileSync(`${outDir}/v1/${x}/${y}.json`, json);
}
writeFileSync(
  `${outDir}/index.json`,
  JSON.stringify({
    version: 1,
    built,
    tiles: tiles.size,
    ways,
    cameras,
    cameraSource: official.length ? 'data.go.kr' : 'osm',
    cameraCodes:
      camerasFile && existsSync(`${camerasFile}.stats.json`) ? JSON.parse(readFileSync(`${camerasFile}.stats.json`, 'utf8')) : undefined,
  }),
);
writeFileSync(`${outDir}/.nojekyll`, '');
console.log(
  `${features} features → ${ways} ways, ${cameras} cameras in ${tiles.size} tiles, ${(bytes / 1e6).toFixed(1)} MB (built ${built})`,
);
