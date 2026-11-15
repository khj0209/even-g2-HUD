export interface LatLon {
  lat: number;
  lon: number;
}

/** One position fix. `speed` is m/s, `heading` is degrees clockwise from north. */
export interface Fix extends LatLon {
  speed: number | null;
  heading: number | null;
  accuracy?: number;
  ts: number;
}

export type Unit = 'kmh' | 'mph';

/** full: everything · minimal: speed + limit only · text: no images (fastest refresh) */
export type DisplayMode = 'full' | 'minimal' | 'text';
export const DISPLAY_MODES: DisplayMode[] = ['full', 'minimal', 'text'];

export interface Settings {
  unit: Unit;
  mode: DisplayMode;
  /** km/h over the limit before the overspeed warning shows. */
  overspeedTolerance: number;
  cameraAlerts: boolean;
  demo: boolean;
  /** Personal Tmap(SK open api) appKey. Empty string falls back to OSRM/Nominatim. */
  tmapApiKey: string;
}

export const DEFAULT_SETTINGS: Settings = {
  unit: 'kmh',
  mode: 'full',
  overspeedTolerance: 0,
  cameraAlerts: true,
  demo: false,
  tmapApiKey: '',
};

export type ManeuverIcon =
  | 'straight'
  | 'slight-left'
  | 'left'
  | 'sharp-left'
  | 'slight-right'
  | 'right'
  | 'sharp-right'
  | 'uturn'
  | 'roundabout'
  | 'arrive';

export interface NavProgress {
  icon: ManeuverIcon;
  /** Metres to the next manoeuvre. */
  distToManeuver: number;
  /** Road entered after the manoeuvre (may be empty). */
  roadName: string;
  remainingDist: number;
  /** Seconds. */
  remainingTime: number;
}

export interface CameraAlert {
  dist: number;
  /** km/h, if tagged. */
  limit: number | null;
}
