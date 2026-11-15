import { compass } from '../core/geo';
import { displayLimit, displaySpeed, formatClock, formatDistance, KMH_PER_MPS, unitLabel } from '../core/format';
import type { CameraAlert, Fix, ManeuverIcon, NavProgress, Settings } from '../core/types';

export interface HudInput {
  /** Latest fix, or null when GPS is missing/stale. */
  fix: Fix | null;
  /** Speed limit of the current road in km/h. */
  limit: number | null;
  camera: CameraAlert | null;
  nav: NavProgress | null;
  settings: Settings;
  now: Date;
}

/** Everything the HUD shows, already formatted. Pure data so it can be tested without a display. */
export interface HudView {
  speed: string;
  unit: string;
  /** Driving faster than limit + tolerance. */
  over: boolean;
  limit: number | null;
  nav: { icon: ManeuverIcon; dist: string; road: string; trip: string } | null;
  status: string;
  alert: string;
}

const ICON_TEXT: Record<ManeuverIcon, string> = {
  straight: '직진',
  'slight-left': '왼쪽 방향',
  left: '좌회전',
  'sharp-left': '급좌회전',
  'slight-right': '오른쪽 방향',
  right: '우회전',
  'sharp-right': '급우회전',
  uturn: '유턴',
  roundabout: '회전교차로',
  arrive: '도착',
};

export function buildView(input: HudInput): HudView {
  const { fix, limit, camera, nav, settings, now } = input;
  const { unit } = settings;
  const kmh = fix?.speed != null ? fix.speed * KMH_PER_MPS : null;

  const status = [formatClock(now)];
  if (fix?.heading != null) status.push(compass(fix.heading));
  if (!fix) status.push('GPS 없음');

  let alert = '';
  if (settings.cameraAlerts && camera) {
    alert = `단속 ${formatDistance(camera.dist, unit)}`;
    if (camera.limit) alert += `\n제한 ${displayLimit(camera.limit, unit)}`;
  }

  return {
    speed: fix?.speed != null ? String(displaySpeed(fix.speed, unit)) : '--',
    unit: unitLabel(unit),
    over: kmh != null && limit != null && kmh > limit + settings.overspeedTolerance,
    limit: limit != null ? displayLimit(limit, unit) : null,
    nav: nav && {
      icon: nav.icon,
      dist: formatDistance(nav.distToManeuver, unit),
      road: nav.roadName,
      trip: `${formatDistance(nav.remainingDist, unit)} · ${formatClock(new Date(now.getTime() + nav.remainingTime * 1000))} 도착`,
    },
    status: status.join('  '),
    alert,
  };
}

/** Lines for the nav text block next to the arrow. */
export function navLines(view: HudView): string {
  if (!view.nav) return ' ';
  return [view.nav.dist, view.nav.road, view.nav.trip].filter(Boolean).join('\n');
}

/** The whole HUD as text, for text-only mode (no image transfers, so it updates fastest). */
export function textModeLines(view: HudView): string {
  let first = `${view.speed} ${view.unit}`;
  if (view.limit != null) first += `   제한 ${view.limit}${view.over ? ' !' : ''}`;
  const lines = [first];
  if (view.nav) lines.push(`${ICON_TEXT[view.nav.icon]} ${view.nav.dist}${view.nav.road ? ' · ' + view.nav.road : ''}`);
  if (view.alert) lines.push(view.alert.replace('\n', ' · '));
  return lines.join('\n');
}

/** Holds the shown limit steady through GPS jitter and short gaps in map data. */
export class LimitFilter {
  private shown: number | null = null;
  private candidate: number | null = null;
  private count = 0;

  next(raw: number | null): number | null {
    if (raw === this.shown) {
      this.count = 0;
      return this.shown;
    }
    if (raw !== this.candidate) {
      this.candidate = raw;
      this.count = 0;
    }
    // A new limit must repeat twice; losing the limit entirely takes longer.
    if (++this.count >= (raw == null ? 5 : 2)) {
      this.shown = raw;
      this.count = 0;
    }
    return this.shown;
  }
}
