import { destination, distance } from '../core/geo';
import type { Fix, LatLon } from '../core/types';
import {
  DRIVABLE,
  emptyRoadData,
  OVERPASS_ENDPOINTS,
  OverpassClient,
  parseBuildings,
  OverpassError,
  parseOverpass,
  type Building,
  type Camera,
  type MapWay,
  type RoadData,
  type RoadWay,
} from './roads';

/**
 * Map data is fetched and stored in fixed tiles of about 1.1 × 1.1 km (in Korea), so that an area
 * driven once never has to be downloaded again, and a whole route can be fetched ahead of time.
 */
export const TILE_LAT = 0.01;
export const TILE_LON = 0.0125;

/**
 * Two downloads per tile: roads (speed limits, cameras and every drivable road, in one request) and
 * buildings, the biggest, which are only needed at city speeds. Fewer, larger requests go down
 * better with the public servers than many small ones.
 */
export type Layer = 'roads' | 'buildings';
const LAYERS: Layer[] = ['roads', 'buildings'];

export interface Tile {
  /** Row (latitude) index. */
  x: number;
  /** Column (longitude) index. */
  y: number;
}

export const tileOf = (p: LatLon): Tile => ({ x: Math.floor(p.lat / TILE_LAT), y: Math.floor(p.lon / TILE_LON) });
const tileKey = (layer: Layer, t: Tile) => `v2:${layer}:${t.x}:${t.y}`;

/** The tile and its neighbours: every point within ~1.1 km of `p` is in one of them. */
export function tilesAround(p: LatLon, ring = 1): Tile[] {
  const c = tileOf(p);
  const out: Tile[] = [];
  for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++) out.push({ x: c.x + dx, y: c.y + dy });
  return out;
}

function bbox(t: Tile): string {
  const s = t.x * TILE_LAT;
  const w = t.y * TILE_LON;
  return [s, w, s + TILE_LAT, w + TILE_LON].map((v) => v.toFixed(4)).join(',');
}

export function tileQuery(layer: Layer, t: Tile): string {
  const b = bbox(t);
  switch (layer) {
    case 'roads':
      return (
        `[out:json][timeout:25];(way(${b})[highway~"${DRIVABLE.source}"];way(${b})[highway][maxspeed];` +
        `node(${b})[highway=speed_camera];);out body geom qt;`
      );
    case 'buildings':
      // Outlines only (`skel`: no tags), to keep the download small in dense areas.
      return `[out:json][timeout:25];way(${b})[building];out skel geom qt;`;
  }
}

export interface TileData {
  ways?: RoadWay[];
  cameras?: Camera[];
  map?: MapWay[];
  buildings?: Building[];
}

function parseLayer(layer: Layer, json: any): TileData {
  if (layer === 'buildings') return { buildings: parseBuildings(json) };
  const d = parseOverpass(json);
  return { ways: d.ways, cameras: d.cameras, map: d.map };
}

// ---------------------------------------------------------------------------------------------
// Persistent storage

export interface StoredTile {
  savedAt: number;
  data: TileData;
}

export interface TileStore {
  get(key: string): Promise<StoredTile | undefined>;
  put(key: string, tile: StoredTile): Promise<void>;
  count(): Promise<number>;
  clear(): Promise<void>;
}

export class MemoryTileStore implements TileStore {
  private m = new Map<string, StoredTile>();
  async get(key: string) {
    return this.m.get(key);
  }
  async put(key: string, tile: StoredTile) {
    this.m.set(key, tile);
  }
  async count() {
    return this.m.size;
  }
  async clear() {
    this.m.clear();
  }
}

/** Most tiles kept on the phone; the oldest go first. Roughly a city's worth of driving. */
const MAX_STORED_TILES = 1500;

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/** Tiles in the WebView's IndexedDB, which survives closing the app. */
class IdbTileStore implements TileStore {
  private db: Promise<IDBDatabase>;

  constructor() {
    this.db = new Promise((resolve, reject) => {
      const open = indexedDB.open('drivehud-map', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('tiles').createIndex('savedAt', 'savedAt');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }

  private async store(mode: IDBTransactionMode) {
    return (await this.db).transaction('tiles', mode).objectStore('tiles');
  }

  async get(key: string) {
    return req<StoredTile | undefined>((await this.store('readonly')).get(key));
  }

  async put(key: string, tile: StoredTile) {
    const store = await this.store('readwrite');
    await req(store.put(tile, key));
    const n = await req(store.count());
    if (n <= MAX_STORED_TILES) return;
    // Drop the oldest tiles to stay under the cap.
    let extra = n - MAX_STORED_TILES;
    const cursors = store.index('savedAt').openCursor();
    await new Promise<void>((resolve, reject) => {
      cursors.onsuccess = () => {
        const c = cursors.result;
        if (!c || extra-- <= 0) return resolve();
        c.delete();
        c.continue();
      };
      cursors.onerror = () => reject(cursors.error);
    });
  }

  async count() {
    return req((await this.store('readonly')).count());
  }

  async clear() {
    await req((await this.store('readwrite')).clear());
  }
}

/** IndexedDB where available, otherwise memory only (data is then lost when the app closes). */
export function openTileStore(): TileStore {
  try {
    if (typeof indexedDB !== 'undefined') return new IdbTileStore();
  } catch {
    /* fall through */
  }
  return new MemoryTileStore();
}

// ---------------------------------------------------------------------------------------------
// Download queue

/** Stored tiles older than this are downloaded again (roads and limits do change). */
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

interface Job {
  key: string;
  layer: Layer;
  tile: Tile;
  /** 0: needed right now, around the car. 1: prefetch (route, area). */
  prio: number;
  /** Counted in the prefetch progress. */
  counted: boolean;
}

/**
 * Loads tiles from storage, downloading the missing ones one at a time with the ones the car needs
 * now ahead of prefetching. Tiles needed now are kept in memory; prefetched ones only in storage.
 */
class TileCache {
  readonly mem = new Map<string, TileData>();
  private queue: Job[] = [];
  /** Keys being looked up in storage or downloaded. */
  private busy = new Set<string>();
  private failures = new Map<string, { n: number; retryAt: number }>();
  private running = false;
  /** Whole queue paused while the servers are refusing for load; doubles on each refusal. */
  pausedUntil = 0;
  private pauses = 0;
  error = '';
  stored = 0;
  prefetch = { total: 0, done: 0 };

  constructor(
    private store: TileStore,
    private client: OverpassClient,
    private onChange: () => void,
  ) {
    void this.refreshCount();
  }

  /** Make sure these tiles get loaded; cheap to call repeatedly. */
  want(layer: Layer, tiles: Tile[], prio: number): void {
    for (const tile of tiles) {
      const key = tileKey(layer, tile);
      if (prio === 0 && this.mem.has(key)) continue;
      const queued = this.queue.find((j) => j.key === key);
      if (queued) {
        if (prio < queued.prio) {
          queued.prio = prio;
          this.queue.sort((a, b) => a.prio - b.prio);
        }
        continue;
      }
      if (this.busy.has(key)) continue;
      const failed = this.failures.get(key);
      if (failed && Date.now() < failed.retryAt) continue;
      if (prio > 0) this.prefetch.total++;
      this.busy.add(key);
      void this.lookup({ key, layer, tile, prio, counted: prio > 0 });
    }
  }

  /** Storage first (fast, doesn't wait behind downloads); download only if missing or stale. */
  private async lookup(job: Job): Promise<void> {
    const stored = await this.store.get(job.key).catch(() => undefined);
    if (stored && Date.now() - stored.savedAt < MAX_AGE_MS) {
      this.busy.delete(job.key);
      if (job.prio === 0) this.mem.set(job.key, stored.data);
      if (job.counted) this.done();
      else this.onChange();
      return;
    }
    this.busy.delete(job.key);
    this.queue.push(job);
    this.queue.sort((a, b) => a.prio - b.prio);
    void this.pump();
  }

  private done(): void {
    this.prefetch.done++;
    if (this.prefetch.done >= this.prefetch.total) this.prefetch = { total: 0, done: 0 };
    this.onChange();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let job = this.queue.shift(); job; job = this.queue.shift()) {
        const wait = this.pausedUntil - Date.now();
        if (wait > 0) {
          this.onChange();
          await new Promise((r) => setTimeout(r, wait));
        }
        this.busy.add(job.key);
        try {
          const data = parseLayer(job.layer, await this.client.run(tileQuery(job.layer, job.tile)));
          if (job.prio === 0) this.mem.set(job.key, data);
          this.failures.delete(job.key);
          this.error = '';
          this.pauses = 0;
          await this.store.put(job.key, { savedAt: Date.now(), data }).catch((e) => console.warn('[mapcache] store', e));
          void this.refreshCount();
        } catch (e) {
          const n = (this.failures.get(job.key)?.n ?? 0) + 1;
          // Back off while the servers are struggling: 10 s, 20 s, 40 s … up to 2 minutes.
          this.failures.set(job.key, { n, retryAt: Date.now() + Math.min(120000, 10000 * 2 ** (n - 1)) });
          this.error = e instanceof Error ? e.message : String(e);
          // Every server is refusing for load: stop asking for a while (15 s, 30 s, 60 s … 5 min)
          // instead of firing the rest of the queue at them, which only makes it worse.
          if (e instanceof OverpassError && e.busy)
            this.pausedUntil = Date.now() + Math.min(300000, 15000 * 2 ** this.pauses++);
        } finally {
          this.busy.delete(job.key);
        }
        if (job.counted) this.done();
        else this.onChange();
      }
    } finally {
      this.running = false;
    }
  }

  /** Forget in-memory tiles the car has left behind (they stay in storage). */
  keepOnly(keys: Set<string>): void {
    for (const k of this.mem.keys()) if (!keys.has(k)) this.mem.delete(k);
  }

  pending(prio: number): number {
    return this.queue.filter((j) => j.prio === prio).length + (prio === 0 ? this.busy.size : 0);
  }

  async clear(): Promise<void> {
    this.queue = this.queue.filter((j) => j.prio === 0);
    this.prefetch = { total: 0, done: 0 };
    await this.store.clear().catch(() => undefined);
    await this.refreshCount();
  }

  private async refreshCount(): Promise<void> {
    this.stored = await this.store.count().catch(() => 0);
    this.onChange();
  }
}

// ---------------------------------------------------------------------------------------------

/** Buildings only matter at city speeds, and are the biggest download. */
const BUILDING_MAX_KMH = 70;

/** Merge tiles, dropping duplicates of ways that cross tile borders (each tile returns them whole). */
export function mergeTiles(tiles: TileData[]): RoadData {
  const data = emptyRoadData();
  const seen = new Set<string>();
  const add = <T extends { id?: number }>(kind: string, items: T[] | undefined, push: (item: T) => void) => {
    for (const item of items ?? []) {
      if (item.id != null) {
        const k = kind + item.id;
        if (seen.has(k)) continue;
        seen.add(k);
      }
      push(item);
    }
  };
  for (const t of tiles) {
    add('w', t.ways, (w) => data.ways.push(w));
    add('c', t.cameras, (c) => data.cameras.push(c));
    add('m', t.map, (m) => data.map.push(m));
    add('b', t.buildings, (b) => data.buildings.push(b.points));
  }
  return data;
}

/** Tiles covering a route plus about 500 m either side of it. */
export function routeTiles(points: LatLon[]): Tile[] {
  const tiles = new Map<string, Tile>();
  const addAround = (p: LatLon) => {
    for (const q of [p, destination(p, 0, 500), destination(p, 90, 500), destination(p, 180, 500), destination(p, 270, 500)]) {
      const t = tileOf(q);
      tiles.set(`${t.x}:${t.y}`, t);
    }
  };
  for (let i = 0; i < points.length; i++) {
    addAround(points[i]);
    // Fill in long straight segments so no tile along them is skipped.
    if (i + 1 < points.length) {
      const d = distance(points[i], points[i + 1]);
      for (let s = 300; s < d; s += 300) {
        const f = s / d;
        addAround({ lat: points[i].lat + (points[i + 1].lat - points[i].lat) * f, lon: points[i].lon + (points[i + 1].lon - points[i].lon) * f });
      }
    }
  }
  return [...tiles.values()];
}

/** Keeps map data for the area around the car, from storage or downloaded tile by tile. */
export class RoadDataService {
  data: RoadData = emptyRoadData();
  private cache: TileCache;
  private center: Tile | null = null;
  private around: Tile[] = [];
  private wantBuildings = true;

  constructor(
    fetchFn: typeof fetch = (...a) => fetch(...a),
    endpoints = OVERPASS_ENDPOINTS,
    store: TileStore = openTileStore(),
    minGapMs = 1000,
  ) {
    this.cache = new TileCache(store, new OverpassClient(fetchFn, endpoints, minGapMs), () => this.rebuild());
  }

  /** Call on every fix; cheap unless the car has moved into a new tile. */
  update(fix: Fix): void {
    const c = tileOf(fix);
    this.wantBuildings = (fix.speed ?? 0) * 3.6 < BUILDING_MAX_KMH;
    if (!this.center || c.x !== this.center.x || c.y !== this.center.y) {
      this.center = c;
      this.around = tilesAround(fix);
      // Keep a wider ring in memory so driving back and forth across a border doesn't reload.
      const keep = new Set(LAYERS.flatMap((l) => tilesAround(fix, 2).map((t) => tileKey(l, t))));
      this.cache.keepOnly(keep);
      this.rebuild();
    }
    this.cache.want('roads', this.around, 0);
    if (this.wantBuildings) this.cache.want('buildings', this.around, 0);
  }

  /** Download everything along a route ahead of time. */
  prefetchRoute(points: LatLon[]): void {
    const tiles = routeTiles(points);
    for (const layer of LAYERS) this.cache.want(layer, tiles, 1);
  }

  /**
   * Download roads within `radius` metres of `p`, and buildings (the heavy part) within the nearer
   * ~1.5 km only.
   */
  prefetchArea(p: LatLon, radius: number): void {
    this.cache.want('roads', tilesAround(p, Math.ceil(radius / 1100)), 1);
    this.cache.want('buildings', tilesAround(p, 1), 1);
  }

  clearStored(): Promise<void> {
    return this.cache.clear();
  }

  private rebuild(): void {
    if (!this.center) return;
    const tiles = LAYERS.flatMap((l) => this.around.map((t) => this.cache.mem.get(tileKey(l, t)))).filter(
      (t): t is TileData => !!t,
    );
    this.data = mergeTiles(tiles);
  }

  /** One line for the phone page, e.g. "제한속도 40 · 도로 120 · 건물 340 · 저장된 구역 85". */
  statusText(): string {
    const loaded = (l: Layer) => this.around.length > 0 && this.around.every((t) => this.cache.mem.has(tileKey(l, t)));
    const part = (label: string, l: Layer, n: number) =>
      !this.center ? `${label} 대기` : loaded(l) ? `${label} ${n}` : n ? `${label} ${n}+` : `${label} 받는 중`;
    const parts = [
      part('제한속도', 'roads', this.data.ways.length),
      part('도로', 'roads', this.data.map.length),
      this.wantBuildings || this.data.buildings.length ? part('건물', 'buildings', this.data.buildings.length) : '건물 고속 주행 중 생략',
    ];
    const { total, done } = this.cache.prefetch;
    if (total) parts.push(`미리 받기 ${done}/${total}`);
    parts.push(`저장된 구역 ${this.cache.stored}`);
    const paused = Math.ceil((this.cache.pausedUntil - Date.now()) / 1000);
    if (paused > 0) parts.push(`서버 혼잡, ${paused}초 후 다시 시도`);
    if (this.cache.error) parts.push(`오류: ${this.cache.error}`);
    return parts.join(' · ');
  }
}
