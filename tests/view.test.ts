import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Fix } from '../src/core/types';
import { buildView, LimitFilter, textModeLines, type HudInput } from '../src/hud/view';
import { FixNormalizer } from '../src/services/location';

const now = new Date(2026, 0, 1, 14, 5);
const fix = (kmh: number): Fix => ({ lat: 37.5, lon: 127, speed: kmh / 3.6, heading: 45, ts: now.getTime() });
const input = (over: Partial<HudInput> = {}): HudInput => ({
  fix: fix(63),
  limit: 60,
  camera: null,
  nav: null,
  settings: DEFAULT_SETTINGS,
  now,
  ...over,
});

describe('buildView', () => {
  it('shows speed, limit and overspeed', () => {
    const v = buildView(input());
    expect(v).toMatchObject({ speed: '63', unit: 'km/h', limit: 60, over: true, info: '14:05  NE', alert: '', nav: null });
  });

  it('respects the overspeed tolerance', () => {
    const settings = { ...DEFAULT_SETTINGS, overspeedTolerance: 5 };
    expect(buildView(input({ settings })).over).toBe(false);
    expect(buildView(input({ settings, fix: fix(66) })).over).toBe(true);
  });

  it('shows placeholders without GPS', () => {
    const v = buildView(input({ fix: null, limit: null }));
    expect(v).toMatchObject({ speed: '--', over: false, limit: null, info: '14:05  GPS 없음' });
  });

  it('converts to mph', () => {
    const v = buildView(input({ settings: { ...DEFAULT_SETTINGS, unit: 'mph' }, fix: fix(100), limit: 80 }));
    expect(v).toMatchObject({ speed: '62', unit: 'mph', limit: 50, over: true });
  });

  it('formats navigation and camera alerts', () => {
    const v = buildView(
      input({
        nav: { icon: 'left', distToManeuver: 337, roadName: '테헤란로', remainingDist: 12400, remainingTime: 27 * 60 },
        camera: { dist: 280, limit: 50 },
      }),
    );
    expect(v.nav).toEqual({ icon: 'left', dist: '350 m' });
    expect(v.info).toBe('테헤란로  12 km · 14:32 도착');
    expect(v.alert).toBe('단속 300 m');
    expect(textModeLines(v)).toBe('63 km/h   제한 60 !   단속 300 m\n좌회전 350 m\n테헤란로  12 km · 14:32 도착');
  });

  it('falls back to the camera limit on roads with no tagged limit', () => {
    const v = buildView(input({ limit: null, camera: { dist: 280, limit: 50 } }));
    expect(v).toMatchObject({ limit: 50, over: true });
  });

  it('hides camera alerts when disabled', () => {
    const v = buildView(input({ camera: { dist: 280, limit: 50 }, settings: { ...DEFAULT_SETTINGS, cameraAlerts: false } }));
    expect(v.alert).toBe('');
  });
});

describe('LimitFilter', () => {
  it('needs two matching readings to change and five to clear', () => {
    const f = new LimitFilter();
    expect(f.next(50)).toBeNull();
    expect(f.next(50)).toBe(50);
    expect(f.next(30)).toBe(50); // one stray reading at a junction
    expect(f.next(50)).toBe(50);
    expect([null, null, null, null].map((v) => f.next(v))).toEqual([50, 50, 50, 50]);
    expect(f.next(null)).toBeNull();
  });
});

describe('FixNormalizer', () => {
  it('derives speed and heading from movement when the platform omits them', () => {
    const n = new FixNormalizer();
    n.next({ lat: 37.5, lon: 127, speed: null, heading: null, ts: 0 });
    const f = n.next({ lat: 37.5001, lon: 127, speed: null, heading: null, ts: 1000 });
    expect(f.speed).toBeCloseTo(11.1, 1);
    expect(f.heading).toBeCloseTo(0, 3);
  });

  it('ignores invalid values and keeps the last heading at standstill', () => {
    const n = new FixNormalizer();
    expect(n.next({ lat: 37.5, lon: 127, speed: 10, heading: 90, ts: 0 }).heading).toBe(90);
    const stopped = n.next({ lat: 37.5, lon: 127, speed: 0.2, heading: 200, ts: 1000 });
    expect(stopped.heading).toBe(90);
    expect(n.next({ lat: 37.5, lon: 127, speed: -1, heading: -1, ts: 2000 }).speed).toBe(0);
  });
});
