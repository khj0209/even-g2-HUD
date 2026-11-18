import { describe, expect, it } from 'vitest';
import type { Fix } from '../src/core/types';
import {
  MemoryTileStore,
  mergeTiles,
  RoadDataService,
  routeTiles,
  tileOf,
  tileQuery,
  tilesAround,
  type TileStore,
} from '../src/services/mapcache';

const settle = async () => {
  for (let i = 0; i < 60; i++) await new Promise((r) => setTimeout(r, 0));
};

const fix = (lat = 37.5355, lon = 126.6431, kmh = 30): Fix => ({ lat, lon, speed: kmh / 3.6, heading: 0, ts: Date.now() });

/** Fake Overpass: answers by layer, and records every query. */
function fakeOverpass(status = 200) {
  const queries: string[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const q = decodeURIComponent(String(init.body)).slice(5);
    queries.push(q);
    if (status !== 200) return new Response('', { status });
    const g = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }];
    // Same ids from every tile, like a way crossing tile borders.
    const elements = q.includes('[building]')
      ? [{ type: 'way', id: 3, geometry: g }]
      : q.includes('highway~')
        ? [{ type: 'way', id: 2, tags: { highway: 'primary' }, geometry: g }]
        : [{ type: 'way', id: 1, tags: { highway: 'primary', maxspeed: '50' }, geometry: g }];
    return new Response(JSON.stringify({ elements }));
  }) as typeof fetch;
  return { fetchFn, queries };
}

describe('tiles', () => {
  it('maps positions to ~1.1 km tiles and asks for a tile by its box', () => {
    const t = tileOf({ lat: 37.5355, lon: 126.6431 });
    expect(t).toEqual({ x: 3753, y: 10131 });
    expect(tileQuery('limits', t)).toBe(
      '[out:json][timeout:25];(way(37.5300,126.6375,37.5400,126.6500)[highway][maxspeed];node(37.5300,126.6375,37.5400,126.6500)[highway=speed_camera];);out body geom;',
    );
    expect(tileQuery('buildings', t)).toContain('way(37.5300,126.6375,37.5400,126.6500)[building];out skel geom qt;');
    expect(tilesAround({ lat: 37.5355, lon: 126.6431 })).toHaveLength(9);
    expect(tilesAround({ lat: 37.5355, lon: 126.6431 }, 3)).toHaveLength(49);
  });

  it('covers a route with a corridor of tiles, including long straight segments', () => {
    // 5 km due east along 37.535°N: tiles in that row, plus the row 500 m north or south as needed.
    const tiles = routeTiles([
      { lat: 37.535, lon: 126.6 },
      { lat: 37.535, lon: 126.6566 },
    ]);
    const cols = new Set(tiles.map((t) => t.y));
    for (let y = tileOf({ lat: 37.535, lon: 126.6 }).y; y <= tileOf({ lat: 37.535, lon: 126.6566 }).y; y++) expect(cols.has(y)).toBe(true);
    expect(tiles.length).toBeLessThan(25);
  });

  it('merges tiles without duplicating ways that cross tile borders', () => {
    const w = { id: 9, maxspeed: 50, points: [] };
    const merged = mergeTiles([{ ways: [w] }, { ways: [w], cameras: [{ lat: 0, lon: 0, maxspeed: null }] }, { buildings: [{ id: 4, points: [] }] }]);
    expect(merged.ways).toHaveLength(1);
    expect(merged.cameras).toHaveLength(1);
    expect(merged.buildings).toHaveLength(1);
  });
});

describe('RoadDataService', () => {
  it('downloads the 3×3 tiles around the car for every layer, limits first', async () => {
    const { fetchFn, queries } = fakeOverpass();
    const svc = new RoadDataService(fetchFn, ['a'], new MemoryTileStore());
    svc.update(fix());
    expect(svc.statusText()).toContain('제한속도 받는 중');
    await settle();
    expect(queries).toHaveLength(27);
    expect(queries[0]).toContain('[maxspeed]');
    expect(svc.data.ways).toHaveLength(1); // deduplicated across the 9 tiles
    expect(svc.statusText()).toBe('제한속도 1 · 도로 1 · 건물 1 · 저장된 구역 27');
  });

  it('reuses stored tiles instead of downloading again', async () => {
    const store = new MemoryTileStore();
    const first = fakeOverpass();
    const a = new RoadDataService(first.fetchFn, ['a'], store);
    a.update(fix());
    await settle();
    const second = fakeOverpass();
    const b = new RoadDataService(second.fetchFn, ['a'], store);
    b.update(fix());
    await settle();
    expect(second.queries).toHaveLength(0);
    expect(b.data.map).toHaveLength(1);
  });

  it('skips buildings at speed', async () => {
    const { fetchFn, queries } = fakeOverpass();
    const svc = new RoadDataService(fetchFn, ['a'], new MemoryTileStore());
    svc.update(fix(37.5355, 126.6431, 90));
    await settle();
    expect(queries.some((q) => q.includes('[building]'))).toBe(false);
    expect(svc.statusText()).toContain('건물 고속 주행 중 생략');
  });

  it('prefetches an area into storage and reports progress', async () => {
    const store = new MemoryTileStore();
    const { fetchFn, queries } = fakeOverpass();
    const svc = new RoadDataService(fetchFn, ['a'], store);
    svc.prefetchArea({ lat: 37.5355, lon: 126.6431 }, 1000);
    expect(svc.statusText()).toContain('미리 받기 0/27');
    await settle();
    expect(queries).toHaveLength(27);
    expect(await store.count()).toBe(27);
    expect(svc.statusText()).not.toContain('미리 받기');
  });

  it('serves the car before prefetching', async () => {
    const { fetchFn, queries } = fakeOverpass();
    const svc = new RoadDataService(fetchFn, ['a'], new MemoryTileStore());
    svc.prefetchArea({ lat: 37.6, lon: 126.7 }, 3000);
    svc.update(fix());
    await settle();
    const carTile = tileOf(fix());
    const firstCar = queries.findIndex((q) => q.includes(`${(carTile.x * 0.01).toFixed(4)},${(carTile.y * 0.0125).toFixed(4)}`));
    expect(firstCar).toBeLessThan(5); // at most the one prefetch request already in flight
  });

  it('shows the error and keeps going when downloads fail', async () => {
    const { fetchFn } = fakeOverpass(502);
    const svc = new RoadDataService(fetchFn, ['a'], new MemoryTileStore());
    svc.update(fix());
    await settle();
    expect(svc.statusText()).toContain('오류: HTTP 502');
    expect(svc.statusText()).toContain('제한속도 받는 중');
  });

  it('works without storage that keeps anything', async () => {
    const broken: TileStore = {
      get: () => Promise.reject(new Error('no db')),
      put: () => Promise.reject(new Error('no db')),
      count: () => Promise.reject(new Error('no db')),
      clear: () => Promise.reject(new Error('no db')),
    };
    const { fetchFn } = fakeOverpass();
    const svc = new RoadDataService(fetchFn, ['a'], broken);
    svc.update(fix());
    await settle();
    expect(svc.data.ways).toHaveLength(1);
  });
});
