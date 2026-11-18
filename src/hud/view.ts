import { compass, localOffset, projectOnSegment } from '../core/geo';
import { displayLimit, displaySpeed, formatClock, formatDistance, KMH_PER_MPS, unitLabel } from '../core/format';
import type { CameraAlert, Fix, LatLon, ManeuverIcon, MinimapView, NavProgress, Settings } from '../core/types';
import type { Route } from '../services/routing';

export interface HudInput {
  /** Latest fix, or null when GPS is missing/stale. */
  fix: Fix | null;
  /** Speed limit of the current road in km/h. */
  limit: number | null;
  camera: CameraAlert | null;
  nav: NavProgress | null;
  /** Active route, for the minimap. Null when not navigating. */
  route: Route | null;
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
  /** Null when there's no route to show (not navigating). */
  minimap: MinimapView | null;
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

/** Metres from the car to the edge of the minimap box. */
const MINIMAP_RADIUS_M = 150;
/** Half the minimap image, in pixels, leaving a margin inside its 100×100 box. */
const MINIMAP_PX = 42;

/** Distance travelled to the point on the route closest to `fix` (same approach as RouteTracker). */
function travelledAt(route: Route, fix: Fix): number {
  const { points, cum } = route;
  let best = { dist: Infinity, seg: 0, t: 0 };
  for (let i = 0; i + 1 < points.length; i++) {
    const p = projectOnSegment(fix, points[i], points[i + 1]);
    if (p.dist < best.dist) best = { dist: p.dist, seg: i, t: p.t };
  }
  return cum[best.seg] + best.t * (cum[best.seg + 1] - cum[best.seg]);
}

/**
 * Vertices spanning `travelled ± radius` along the route. Picked by cumulative distance, not raw
 * distance from the car, so a long unsplit leg (demo routes; occasionally a real one) still yields
 * a line through the box instead of vanishing because both its vertices sit outside `radius`.
 */
function routeWindow(route: Route, travelled: number, radius: number): LatLon[] {
  const { points, cum } = route;
  const lo = travelled - radius;
  const hi = travelled + radius;
  let start = 0;
  while (start + 1 < points.length && cum[start + 1] < lo) start++;
  let end = points.length - 1;
  while (end > 0 && cum[end - 1] > hi) end--;
  return points.slice(start, end + 1);
}

/** Route points near the car, heading-up rotated and scaled to pixels. Null when not navigating. */
function buildMinimap(route: Route | null, fix: Fix | null, nav: NavProgress | null): MinimapView | null {
  if (!route || !fix || route.points.length < 2) return null;
  // While guiding, reuse the tracker's position along the route: it searches near the last match,
  // so a route that doubles back near itself can't make the minimap jump to the wrong stretch.
  const travelled = nav ? route.distance - nav.remainingDist : travelledAt(route, fix);
  const windowPts = routeWindow(route, travelled, MINIMAP_RADIUS_M);
  if (windowPts.length < 2) return null;
  const headingKnown = fix.heading != null;
  const h = ((fix.heading ?? 0) * Math.PI) / 180;
  const cosH = Math.cos(h);
  const sinH = Math.sin(h);
  const scale = MINIMAP_PX / MINIMAP_RADIUS_M;
  const points = windowPts.map((p) => {
    const { east, north } = localOffset(fix, p);
    return { x: (east * cosH - north * sinH) * scale, y: -(east * sinH + north * cosH) * scale };
  });
  return { points, headingKnown };
}

export function buildView(input: HudInput): HudView {
  const { fix, camera, nav, route, settings, now } = input;
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
    minimap: buildMinimap(route, fix, nav),
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
