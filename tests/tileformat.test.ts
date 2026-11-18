import { describe, expect, it } from 'vitest';
import { classify, decodeTile, encodeTile, splitByTile, tileOf } from '../src/services/tileformat';

describe('classify', () => {
  it('keeps drivable roads and anything with a limit', () => {
    expect(classify({ highway: 'primary', maxspeed: '60' })).toEqual({ drivable: true, major: true, maxspeed: 60 });
    expect(classify({ highway: 'residential' })).toEqual({ drivable: true, major: false, maxspeed: 0 });
    expect(classify({ highway: 'service', maxspeed: '20' })).toEqual({ drivable: false, major: false, maxspeed: 20 });
    expect(classify({ highway: 'footway' })).toBeNull();
    expect(classify({ building: 'yes' })).toBeNull();
  });
});

describe('splitByTile', () => {
  it('cuts a polyline into per-tile pieces that overlap by the border-crossing segment', () => {
    // Three points in one tile row, the last one in the next column.
    const pts = [
      { lat: 37.535, lon: 126.64 },
      { lat: 37.535, lon: 126.645 },
      { lat: 37.535, lon: 126.652 },
    ];
    const a = tileOf(pts[0]);
    const b = tileOf(pts[2]);
    const out = splitByTile(pts);
    expect([...out.keys()].sort()).toEqual([`${a.x}:${a.y}`, `${b.x}:${b.y}`].sort());
    expect(out.get(`${a.x}:${a.y}`)).toEqual([pts]);
    expect(out.get(`${b.x}:${b.y}`)).toEqual([pts.slice(1)]);
  });

  it('does not skip a tile a long segment passes through', () => {
    const out = splitByTile([
      { lat: 37.535, lon: 126.6 },
      { lat: 37.535, lon: 126.7 },
    ]);
    expect(out.size).toBe(tileOf({ lat: 37.535, lon: 126.7 }).y - tileOf({ lat: 37.535, lon: 126.6 }).y + 1);
  });

  it('starts a new piece when a way leaves a tile and comes back', () => {
    const pts = [
      { lat: 37.535, lon: 126.645 },
      { lat: 37.535, lon: 126.655 }, // next tile
      { lat: 37.536, lon: 126.655 },
      { lat: 37.536, lon: 126.645 }, // back
    ];
    const home = tileOf(pts[0]);
    expect(splitByTile(pts).get(`${home.x}:${home.y}`)).toHaveLength(2);
  });
});

describe('encode/decode', () => {
  it('round-trips to about a metre', () => {
    const ways = [{ drivable: true, major: false, maxspeed: 50, points: [{ lat: 37.123456, lon: 126.987654 }, { lat: 37.12401, lon: 126.98801 }] }];
    const back = decodeTile(JSON.parse(encodeTile(ways, [{ lat: 37.5, lon: 127, maxspeed: null }])));
    expect(back.ways[0]).toMatchObject({ drivable: true, major: false, maxspeed: 50 });
    expect(back.ways[0].points[0].lat).toBeCloseTo(37.12346, 5);
    expect(back.ways[0].points[1].lon).toBeCloseTo(126.98801, 5);
    expect(back.cameras).toEqual([{ lat: 37.5, lon: 127, maxspeed: null }]);
  });
});
