import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { DEFAULT_SETTINGS, type Fix, type LatLon, type NavProgress, type Settings } from './core/types';
import { GlassesSink } from './hud/glasses';
import { HudRenderer, type HudSink } from './hud/renderer';
import { buildView, LimitFilter, type HudView } from './hud/view';
import { demoRoadData, demoRoute } from './services/demo';
import {
  BridgeLocationSource,
  BrowserLocationSource,
  DemoLocationSource,
  FixNormalizer,
  type LocationSource,
} from './services/location';
import { deadReckon, DR_START_MS, MapMatcher, type PathRef } from './services/matching';
import { RoadDataService } from './services/mapcache';
import { TmapLimitService } from './services/tmaplimit';
import { CameraTracker, matchLimit, type RoadData } from './services/roads';
import { fetchRoute, RouteTracker, type Place } from './services/routing';

const SETTINGS_KEY = 'drivehud.settings';
/** A fix older than this is treated as "no GPS". */
const STALE_MS = 5000;
/** With GPS gone and nothing to extrapolate (stopped, or no heading), keep the last place this long. */
const HOLD_MS = 60000;
/** Keep showing the last turn instruction this long through a gap in guidance. */
const NAV_HOLD_MS = 15000;
const REROUTE_INTERVAL_MS = 10000;

export interface AppState {
  view: HudView;
  settings: Settings;
  glasses: boolean;
  gps: boolean;
  destination: Place | null;
  /** Last known position (even if stale), to bias destination search towards. */
  position: LatLon | null;
  /** Human-readable navigation status / error for the phone page. */
  navMessage: string;
  /** Map data status for the phone page. */
  mapStatus: string;
}

export class App {
  settings: Settings = { ...DEFAULT_SETTINGS };
  private bridge: EvenAppBridge | null = null;
  private glasses: GlassesSink | null = null;
  private renderer = new HudRenderer();
  private source: LocationSource | null = null;
  private normalizer = new FixNormalizer();
  private matcher = new MapMatcher();
  private cameras = new CameraTracker();
  private lastNav: { nav: NavProgress; at: number } | null = null;
  private tmapLimits = new TmapLimitService();
  /** Where the last real fix was matched on the map, for dead reckoning through tunnels. */
  private lastRef: PathRef | null = null;
  private roadPaths: { data: RoadData | null; paths: ReturnType<typeof roadPaths> } = { data: null, paths: [] };
  private roads = new RoadDataService();
  private limitFilter = new LimitFilter();
  private tracker: RouteTracker | null = null;
  private destination: Place | null = null;
  private navMessage = '';
  private fix: Fix | null = null;
  private lastReroute = 0;
  private listeners: ((s: AppState) => void)[] = [];

  /** `forceDemo` pins demo mode on regardless of saved settings (the `?demo` URL flag). */
  constructor(
    preview: HudSink,
    private forceDemo = false,
  ) {
    this.renderer.addSink(preview);
    this.loadSettings(localStorage.getItem(SETTINGS_KEY));
  }

  start(): void {
    this.renderer.start();
    this.restartLocation();
    setInterval(() => this.tick(), 1000);
    this.tick();
  }

  /** Called once the Even App bridge is up: adds the glasses and switches to the app's GPS. */
  async attachBridge(bridge: EvenAppBridge): Promise<void> {
    this.bridge = bridge;
    this.loadSettings(await bridge.getLocalStorage(SETTINGS_KEY).catch(() => ''));
    this.glasses = new GlassesSink(bridge, {
      onDoubleClick: () => this.glasses?.exit(),
      onResume: () => this.renderer.redraw(),
    });
    this.renderer.addSink(this.glasses);
    this.restartLocation();
    this.tick();
  }

  onState(fn: (s: AppState) => void): void {
    this.listeners.push(fn);
  }

  updateSettings(patch: Partial<Settings>): void {
    const demoChanged = patch.demo != null && patch.demo !== this.settings.demo;
    this.settings = { ...this.settings, ...patch };
    const json = JSON.stringify(this.settings);
    localStorage.setItem(SETTINGS_KEY, json);
    void this.bridge?.setLocalStorage(SETTINGS_KEY, json);
    if (demoChanged) this.restartLocation();
    this.tick();
  }

  async navigateTo(place: Place): Promise<void> {
    if (this.settings.demo) return;
    if (!this.fix) {
      this.navMessage = 'GPS 신호를 기다리는 중입니다';
      this.tick();
      return;
    }
    this.destination = place;
    this.navMessage = '경로 탐색 중…';
    this.tick();
    try {
      this.tracker = new RouteTracker(await fetchRoute(this.fix, place, this.settings.tmapApiKey));
      this.navMessage = '';
      // Fetch the map along the whole route now, while there's signal, so tunnels and server
      // hiccups on the way don't leave gaps.
      this.roads.prefetchRoute(this.tracker.route.points);
    } catch (e) {
      this.tracker = null;
      this.navMessage = e instanceof Error ? e.message : String(e);
    }
    this.tick();
  }

  /** Download the map within 3 km of the current position for later use. */
  prefetchHere(): void {
    if (this.settings.demo || !this.fix) {
      this.navMessage = this.settings.demo ? '데모 주행 중에는 지도를 받지 않습니다' : 'GPS 신호를 기다리는 중입니다';
    } else this.roads.prefetchArea(this.fix, 3000);
    this.tick();
  }

  async clearStoredMap(): Promise<void> {
    await this.roads.clearStored();
    this.tick();
  }

  stopNavigation(message = ''): void {
    this.tracker = null;
    this.destination = null;
    this.navMessage = message;
    this.tick();
  }

  private loadSettings(json: string | null): void {
    try {
      if (json) this.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(json) };
    } catch {
      /* corrupt settings: keep defaults */
    }
    if (this.forceDemo) this.settings.demo = true;
  }

  private restartLocation(): void {
    this.source?.stop();
    this.fix = null;
    this.normalizer = new FixNormalizer();
    this.matcher = new MapMatcher();
    this.lastRef = null;
    this.cameras = new CameraTracker();
    this.lastNav = null;
    this.limitFilter = new LimitFilter();
    this.roads = new RoadDataService();
    this.tracker = null;
    this.destination = null;
    this.navMessage = '';
    if (this.settings.demo) {
      this.roads.data = demoRoadData();
      this.tracker = new RouteTracker(demoRoute());
      this.source = new DemoLocationSource();
    } else {
      this.source = this.bridge ? new BridgeLocationSource(this.bridge) : new BrowserLocationSource();
    }
    this.source.start((raw) => {
      const fix = this.normalizer.next(raw);
      if (!fix) return; // skipped: inaccurate, duplicate or a glitch
      this.fix = this.matcher.snap(fix, this.tracker?.route.points ?? null, this.mapPaths());
      this.lastRef = this.matcher.last;
      if (!this.settings.demo) this.tmapLimits.update(this.fix, this.settings.tmapApiKey, this.matcher.road);
      this.tick();
    });
  }

  /** Minimap road polylines, rebuilt only when new map data arrives. */
  private mapPaths() {
    if (this.roadPaths.data !== this.roads.data) this.roadPaths = { data: this.roads.data, paths: roadPaths(this.roads.data) };
    return this.roadPaths.paths;
  }

  private trackRoute(fix: Fix): NavProgress | null {
    if (!this.tracker) return null;
    const result = this.tracker.update(fix);
    if (result.state === 'guiding') return result.progress;
    // An estimated position drifting off the route is no reason to reroute or announce arrival.
    if (fix.estimated) return null;
    if (this.settings.demo) {
      this.tracker = new RouteTracker(demoRoute()); // loop the demo drive
    } else if (result.state === 'arrived') {
      this.stopNavigation('목적지에 도착했습니다');
    } else if (this.destination && Date.now() - this.lastReroute > REROUTE_INTERVAL_MS) {
      this.lastReroute = Date.now();
      void this.navigateTo(this.destination);
    }
    return null;
  }

  /**
   * The position to show: the last real fix while it is recent; then, if GPS has gone quiet while
   * driving (tunnel, underpass), an estimate along the road; otherwise nothing once it is stale.
   */
  private currentFix(now: number): Fix | null {
    if (!this.fix) return null;
    const age = now - this.fix.ts;
    if (age < DR_START_MS) return this.fix;
    const dr = deadReckon(this.fix, this.lastRef, age, now);
    if (dr) return dr;
    if (age < STALE_MS) return this.fix;
    // Stopped (at lights, in a car park) or nothing to follow: a car that isn't moving hasn't gone
    // anywhere, so keep the last place rather than blanking the HUD.
    if (age < HOLD_MS) return { ...this.fix, estimated: true };
    return null;
  }

  private tick(): void {
    const now = new Date();
    const fix = this.currentFix(now.getTime());
    let limit: number | null = null;
    let camera = null;
    let nav = null;
    if (fix) {
      if (!this.settings.demo) this.roads.update(fix);
      // Tmap's limit (if a key is set and it has one here) over OpenStreetMap's: it's what Korean
      // navigation uses and far more complete.
      const tmap = this.settings.demo ? null : this.tmapLimits.limitAt(fix);
      limit = this.limitFilter.next(tmap ?? matchLimit(this.roads.data, fix));
      camera = this.cameras.next(this.roads.data, fix);
      nav = this.trackRoute(fix);
    } else limit = this.limitFilter.current;
    // Ride out short gaps in guidance (a stray fix off the route, GPS dropping out).
    const t = now.getTime();
    if (nav) this.lastNav = { nav, at: t };
    else if (this.tracker && this.lastNav && t - this.lastNav.at < NAV_HOLD_MS) nav = this.lastNav.nav;
    const view = buildView({ fix, limit, camera, nav, route: this.tracker?.route ?? null, roads: this.roads.data, settings: this.settings, now });
    this.renderer.render(view);
    const state: AppState = {
      view,
      settings: this.settings,
      glasses: !!this.glasses,
      gps: !!fix && !fix.estimated,
      destination: this.destination,
      position: this.fix && { lat: this.fix.lat, lon: this.fix.lon },
      navMessage: this.navMessage,
      mapStatus: this.settings.demo
        ? '지도: 데모 데이터'
        : `지도: ${this.roads.statusText()}${this.settings.tmapApiKey ? ` · ${this.tmapLimits.statusText()}` : ''}`,
    };
    for (const fn of this.listeners) fn(state);
  }
}

const roadPaths = (data: RoadData) => data.map.map((w) => w.points);
