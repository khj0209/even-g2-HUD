// Downloads the national speed camera dataset (공공데이터포털 "전국무인교통단속카메라표준데이터")
// through its OpenAPI and writes the cameras the HUD needs as JSON.
//
//   DATA_GO_KR_KEY=… node scripts/fetch-cameras.ts cameras.json
//
// The key is the portal's personal service key, with this dataset's API applied for.
import { writeFileSync } from 'node:fs';
import { parseOfficialCamera, type BundledCamera } from '../src/services/tileformat.ts';

const API = 'https://api.data.go.kr/openapi/tn_pubr_public_unmanned_traffic_camera_api';
const out = process.argv[2] ?? 'cameras.json';
let key = process.env.DATA_GO_KR_KEY ?? '';
// The portal shows the key both URL-encoded and plain; accept either.
if (key.includes('%')) key = decodeURIComponent(key);
if (!key) {
  console.log('DATA_GO_KR_KEY not set: skipping official cameras (OpenStreetMap cameras will be used).');
  writeFileSync(out, '[]');
  process.exit(0);
}

const cameras: BundledCamera[] = [];
const tally = new Map<string, number>();
const count = (k: string) => tally.set(k, (tally.get(k) ?? 0) + 1);
for (let page = 1; page <= 200; page++) {
  const params = new URLSearchParams({ serviceKey: key, pageNo: String(page), numOfRows: '1000', type: 'json' });
  let json: any = null;
  let lastError = '';
  for (let attempt = 0; attempt < 5 && !json; attempt++) {
    try {
      const r = await fetch(`${API}?${params}`, { signal: AbortSignal.timeout(60000) });
      const text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
      json = JSON.parse(text);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      console.warn(`page ${page} attempt ${attempt + 1}:`, lastError);
      await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt));
    }
  }
  const header = json?.response?.header;
  if (!json || (header && header.resultCode !== '00')) {
    // Don't take the whole map build down with it: fall back to OpenStreetMap's cameras.
    // e.g. SERVICE_KEY_IS_NOT_REGISTERED_ERROR: the key isn't active (yet) for this API.
    const short = (lastError.match(/"errMsg":\s*"([^"]+)"/)?.[1] ?? lastError).slice(0, 160);
    const why = json ? `API error ${header.resultCode}: ${header.resultMsg}` : `page ${page}: ${short}`;
    console.log(`::warning::Official cameras unavailable (${why}); using OpenStreetMap cameras.`);
    writeFileSync(out, '[]');
    process.exit(0);
  }
  let items = json?.response?.body?.items ?? [];
  if (!Array.isArray(items)) items = items.item ?? [];
  for (const row of items) {
    count(`단속구분 ${row.regltSe || '-'} / 구간위치 ${row.regltSctnLcSe || '-'} / 제한속도 ${Number(row.lmttVe) > 0 ? 'O' : 'X'}`);
    const cam = parseOfficialCamera(row);
    if (cam) cameras.push(cam);
  }
  if (items.length < 1000) break;
}

writeFileSync(out, JSON.stringify(cameras));
// Code tally next to the cameras, so the tile index (and the deploy check) can show it.
writeFileSync(`${out}.stats.json`, JSON.stringify(Object.fromEntries([...tally].sort((a, b) => b[1] - a[1]))));
console.log(`${cameras.length} cameras`);
// So the codes can be checked against what the HUD assumes.
for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
