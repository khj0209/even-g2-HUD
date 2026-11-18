import { describe, expect, it } from 'vitest';
import type { Fix } from '../src/core/types';
import { buildBuildingQuery, buildQuery, parseBuildings, cameraAhead, matchLimit, parseMaxspeed, parseOverpass, type RoadData } from '../src/services/roads';

const fix = (lat: number, lon: number, heading: number | null): Fix => ({ lat, lon, heading, speed: 15, ts: 0 });

describe('parseMaxspeed', () => {
  it('reads km/h and mph, rejects non-numeric', () => {
    expect(parseMaxspeed('50')).toBe(50);
    expect(parseMaxspeed('60 km/h')).toBe(60);
    expect(parseMaxspeed('30 mph')).toBe(48);
    expect(parseMaxspeed('signals')).toBeNull();
    expect(parseMaxspeed(undefined)).toBeNull();
  });
});

describe('overpass', () => {
  it('builds a query for ways and cameras', () => {
    const q = buildQuery({ lat: 37.5, lon: 127 });
    expect(q).toContain('way(around:700,37.50000,127.00000)[highway][maxspeed]');
    expect(q).toContain('[highway=speed_camera]');
  });

  it('parses ways with limits and cameras', () => {
    const data = parseOverpass({
      elements: [
        { type: 'way', tags: { maxspeed: '50' }, geometry: [{ lat: 1, lon: 2 }, { lat: 1, lon: 3 }] },
        { type: 'way', tags: { maxspeed: 'none' }, geometry: [{ lat: 1, lon: 2 }, { lat: 1, lon: 3 }] },
        { type: 'node', lat: 5, lon: 6, tags: { highway: 'speed_camera', maxspeed: '60' } },
        { type: 'node', lat: 7, lon: 8, tags: { highway: 'speed_camera' } },
      ],
    });
    expect(data.ways).toHaveLength(1);
    expect(data.ways[0].maxspeed).toBe(50);
    expect(data.map).toEqual([]); // no highway tags on these test ways
    expect(data.cameras).toEqual([
      { lat: 5, lon: 6, maxspeed: 60 },
      { lat: 7, lon: 8, maxspeed: null },
    ]);
  });
});

// An east–west 50 road crossed by a north–south 30 road at (37.5, 127.0).
const data: RoadData = {
  ways: [
    { maxspeed: 50, points: [{ lat: 37.5, lon: 126.99 }, { lat: 37.5, lon: 127.01 }] },
    { maxspeed: 30, points: [{ lat: 37.49, lon: 127.0 }, { lat: 37.51, lon: 127.0 }] },
  ],
  cameras: [{ lat: 37.5, lon: 127.004, maxspeed: 50 }],
  map: [],
  buildings: [],
};

describe('map roads', () => {
  it('keeps drivable roads for the minimap, marking the major ones', () => {
    const geometry = [{ lat: 1, lon: 2 }, { lat: 1, lon: 3 }];
    const data = parseOverpass({
      elements: [
        { type: 'way', tags: { highway: 'primary' }, geometry },
        { type: 'way', tags: { highway: 'residential', maxspeed: '30' }, geometry },
        { type: 'way', tags: { highway: 'motorway_link' }, geometry },
        { type: 'way', tags: { highway: 'footway' }, geometry },
        { type: 'way', tags: { highway: 'service' }, geometry },
      ],
    });
    expect(data.map.map((w) => w.major)).toEqual([true, false, true]);
    expect(data.ways).toHaveLength(1);
  });

  it('asks Overpass for drivable roads too', () => {
    expect(buildQuery({ lat: 37.5, lon: 127 })).toContain('[highway~"^(motorway|trunk|primary');
  });
});

describe('buildings', () => {
  it('asks for outlines only, in a small radius', () => {
    expect(buildBuildingQuery({ lat: 37.5, lon: 127 })).toBe(
      '[out:json][timeout:15];way(around:300,37.50000,127.00000)[building];out skel geom;',
    );
  });

  it('keeps closed outlines and skips broken ones', () => {
    const sq = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 1 },
      { lat: 1, lon: 1 },
      { lat: 0, lon: 0 },
    ];
    expect(parseBuildings({ elements: [{ type: 'way', geometry: sq }, { type: 'way', geometry: sq.slice(0, 2) }, { type: 'way' }] })).toEqual([sq]);
  });
});

describe('matchLimit', () => {
  it('uses heading to pick the right road at a junction', () => {
    expect(matchLimit(data, fix(37.50002, 127.00002, 90))).toBe(50);
    expect(matchLimit(data, fix(37.50002, 127.00002, 270))).toBe(50);
    expect(matchLimit(data, fix(37.50002, 127.00002, 0))).toBe(30);
  });

  it('returns null away from any tagged road', () => {
    expect(matchLimit(data, fix(37.505, 127.005, 90))).toBeNull();
  });

  it('falls back to the nearest road without a heading', () => {
    expect(matchLimit(data, fix(37.5001, 127.003, null))).toBe(50);
  });
});

describe('cameraAhead', () => {
  it('reports a camera in front, not behind or without heading', () => {
    const ahead = cameraAhead(data, fix(37.5, 127.001, 90));
    expect(ahead?.limit).toBe(50);
    expect(ahead?.dist).toBeGreaterThan(250);
    expect(ahead?.dist).toBeLessThan(280);
    expect(cameraAhead(data, fix(37.5, 127.001, 270))).toBeNull();
    expect(cameraAhead(data, fix(37.5, 127.001, null))).toBeNull();
    expect(cameraAhead(data, fix(37.5, 126.99, 90))).toBeNull(); // too far
  });
});
