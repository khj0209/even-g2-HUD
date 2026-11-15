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
  nav: { icon: ManeuverIcon; dist: string } | null;
  /** One line above the cluster: road and arrival while guiding, otherwise clock and heading. */
  info: string;
  /** Short camera warning, e.g. "단속 300 m", or empty. */
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
  const { fix, camera, nav, settings, now } = input;
  const { unit } = settings;
  const kmh = fix?.speed != null ? fix.speed * KMH_PER_MPS : null;
  const cam = settings.cameraAlerts ? camera : null;
  // Where the road itself has no tagged limit, the limit enforced by an upcoming camera still applies.
  const limit = input.limit ?? cam?.limit ?? null;

  let info: string;
  if (!fix) info = `${formatClock(now)}  GPS 없음`;
  else if (nav) {
    const eta = formatClock(new Date(now.getTime() + nav.remainingTime * 1000));
    info = [nav.roadName, `${formatDistance(nav.remainingDist, unit)} · ${eta} 도착`].filter(Boolean).join('  ');
  } else info = [formatClock(now), fix.heading != null ? compass(fix.heading) : ''].filter(Boolean).join('  ');

  return {
    speed: fix?.speed != null ? String(displaySpeed(fix.speed, unit)) : '--',
    unit: unitLabel(unit),
    over: kmh != null && limit != null && kmh > limit + settings.overspeedTolerance,
    limit: limit != null ? displayLimit(limit, unit) : null,
    nav: nav && { icon: nav.icon, dist: formatDistance(nav.distToManeuver, unit) },
    info,
    alert: cam ? `단속 ${formatDistance(cam.dist, unit)}` : '',
  };
}

/** The whole HUD as text, for text-only mode (no image transfers, so it updates fastest). */
export function textModeLines(view: HudView): string {
  let first = `${view.speed} ${view.unit}`;
  if (view.limit != null) first += `   제한 ${view.limit}${view.over ? ' !' : ''}`;
  if (view.alert) first += `   ${view.alert}`;
  const lines = [first];
  if (view.nav) lines.push(`${ICON_TEXT[view.nav.icon]} ${view.nav.dist}`);
  lines.push(view.info);
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
