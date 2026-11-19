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
// Pasted secrets often carry a trailing newline, spaces or quotes; any of them makes the portal
// answer SERVICE_KEY_IS_NOT_REGISTERED_ERROR.
let key = (process.env.DATA_GO_KR_KEY ?? '').trim().replace(/^["']|["']$/g, '').trim();
const raw = process.env.DATA_GO_KR_KEY ?? '';
// The portal shows the key both URL-encoded and plain; accept either.
if (key.includes('%')) key = decodeURIComponent(key);
// Describe the key's shape (never its content) so it can be compared with the portal's.
let shape = '';
if (key) {
  const kinds = [/^[0-9a-f]+$/i.test(key) ? 'hex only' : 'mixed', /[+/=]/.test(key) ? 'has + / =' : '', raw.includes('%') ? 'was URL-encoded' : '', raw !== raw.trim() ? 'had surrounding whitespace' : '']
    .filter(Boolean)
    .join(', ');
  shape = `${key.length} characters, ${kinds}`;
  console.log(`Service key: ${shape}.`);
}
if (!key) {
  console.log('::warning::DATA_GO_KR_KEY is not set (or empty): using OpenStreetMap cameras.');
  writeFileSync(out, '[]');
  process.exit(0);
}

const cameras: BundledCamera[] = [];
const tally = new Map<string, number>();
const count = (k: string) => tally.set(k, (tally.get(k) ?? 0) + 1);
/** What the first page looked like, kept in the stats so a surprise (e.g. 0 rows) can be diagnosed. */
let firstPage: Record<string, unknown> | null = null;

function fallback(why: string): never {
  // Don't take the whole map build down with it: fall back to OpenStreetMap's cameras.
  console.log(`::warning::Official cameras unavailable (${why}; key ${shape}); using OpenStreetMap cameras.`);
  writeFileSync(out, '[]');
  writeFileSync(`${out}.stats.json`, JSON.stringify({ _firstPage: firstPage }));
  process.exit(0);
}

async function getPage(page: number, rows: number): Promise<{ items: any[]; total: number }> {
  const params = new URLSearchParams({ serviceKey: key, pageNo: String(page), numOfRows: String(rows), type: 'json' });
  let text = '';
  let lastError = '';
  let json: any = null;
  for (let attempt = 0; attempt < 5 && !json; attempt++) {
    try {
      const r = await fetch(`${API}?${params}`, { signal: AbortSignal.timeout(60000) });
      text = await r.text();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
      json = JSON.parse(text);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      console.warn(`page ${page} attempt ${attempt + 1}:`, lastError);
      await new Promise((res) => setTimeout(res, 2000 * 2 ** attempt));
    }
  }
  // e.g. SERVICE_KEY_IS_NOT_REGISTERED_ERROR: the key isn't active (yet) for this API.
  if (!json) fallback(`page ${page}: ${(lastError.match(/"errMsg":\s*"([^"]+)"/)?.[1] ?? lastError).slice(0, 160)}`);
  // Some portal APIs wrap the answer in "response", this one answers {header, body} directly.
  const root = json?.response ?? json;
  const header = root?.header;
  const body = root?.body;
  let items = body?.items ?? [];
  if (!Array.isArray(items)) items = items?.item ?? [];
  if (!Array.isArray(items)) items = [items];
  if (page === 1)
    firstPage = {
      rows,
      resultCode: header?.resultCode,
      resultMsg: header?.resultMsg,
      totalCount: body?.totalCount,
      items: items.length,
      keys: Object.keys(root ?? {}),
      sample: text.slice(0, 300),
    };
  if (header && header.resultCode !== '00') fallback(`API error ${header.resultCode}: ${header.resultMsg}`);
  return { items, total: Number(body?.totalCount) || 0 };
}

// Some portal APIs cap the page size and answer an over-large request with no rows: fall back to 100.
let rows = 1000;
let first = await getPage(1, rows);
if (!first.items.length) {
  rows = 100;
  first = await getPage(1, rows);
}
for (let page = 1, res = first; ; ) {
  for (const row of res.items) {
    count(`단속구분 ${row.regltSe || '-'} / 구간위치 ${row.regltSctnLcSe || '-'} / 제한속도 ${Number(row.lmttVe) > 0 ? 'O' : 'X'}`);
    const cam = parseOfficialCamera(row);
    if (cam) cameras.push(cam);
  }
  if (res.items.length < rows || page * rows >= (res.total || Infinity) || page >= 2000) break;
  res = await getPage(++page, rows);
}

writeFileSync(out, JSON.stringify(cameras));
// Code tally next to the cameras, so the tile index (and the deploy check) can show it.
writeFileSync(
  `${out}.stats.json`,
  JSON.stringify({ _firstPage: { ...(firstPage as Record<string, unknown> | null), sample: undefined }, ...Object.fromEntries([...tally].sort((a, b) => b[1] - a[1])) }),
);
console.log(`${cameras.length} cameras`);
// So the codes can be checked against what the HUD assumes.
for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
