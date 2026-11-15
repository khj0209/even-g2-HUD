import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { DEFAULT_SETTINGS, DISPLAY_MODES, type Fix, type NavProgress, type Settings } from './core/types';
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
import { cameraAhead, matchLimit, RoadDataService } from './services/roads';
import { fetchRoute, RouteTracker, type Place } from './services/routing';

const SETTINGS_KEY = 'drivehud.settings';
/** A fix older than this is treated as "no GPS". */
const STALE_MS = 5000;
const REROUTE_INTERVAL_MS = 10000;

export interface AppState {
  view: HudView;
  settings: Settings;
  glasses: boolean;
  gps: boolean;
  destination: Place | null;
  /** Human-readable navigation status / error for the phone page. */
  navMessage: string;
}

export class App {
  settings: Settings = { ...DEFAULT_SETTINGS };
  private bridge: EvenAppBridge | null = null;
  private glasses: GlassesSink | null = null;
  private renderer = new HudRenderer();
  private source: LocationSource | null = null;
  private normalizer = new FixNormalizer();
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
    this.renderer.setMode(this.settings.mode);
    this.restartLocation();
    setInterval(() => this.tick(), 1000);
    this.tick();
  }

  /** Called once the Even App bridge is up: adds the glasses and switches to the app's GPS. */
  async attachBridge(bridge: EvenAppBridge): Promise<void> {
    this.bridge = bridge;
    this.loadSettings(await bridge.getLocalStorage(SETTINGS_KEY).catch(() => ''));
    this.glasses = new GlassesSink(bridge, {
      onClick: () => {
        const i = DISPLAY_MODES.indexOf(this.settings.mode);
        this.updateSettings({ mode: DISPLAY_MODES[(i + 1) % DISPLAY_MODES.length] });
      },
      onDoubleClick: () => this.glasses?.exit(),
      onResume: () => this.renderer.redraw(),
    });
    this.renderer.setMode(this.settings.mode);
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
    this.renderer.setMode(this.settings.mode);
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
    } catch (e) {
      this.tracker = null;
      this.navMessage = e instanceof Error ? e.message : String(e);
    }
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
      this.fix = this.normalizer.next(raw);
      this.tick();
    });
  }

  private trackRoute(fix: Fix): NavProgress | null {
    if (!this.tracker) return null;
    const result = this.tracker.update(fix);
    if (result.state === 'guiding') return result.progress;
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

  private tick(): void {
    const now = new Date();
    const fix = this.fix && now.getTime() - this.fix.ts < STALE_MS ? this.fix : null;
    let limit: number | null = null;
    let camera = null;
    let nav = null;
    if (fix) {
      if (!this.settings.demo) this.roads.update(fix);
      limit = this.limitFilter.next(matchLimit(this.roads.data, fix));
      camera = cameraAhead(this.roads.data, fix);
      nav = this.trackRoute(fix);
    }
    const view = buildView({ fix, limit, camera, nav, route: this.tracker?.route ?? null, settings: this.settings, now });
    this.renderer.render(view);
    const state: AppState = {
      view,
      settings: this.settings,
      glasses: !!this.glasses,
      gps: !!fix,
      destination: this.destination,
      navMessage: this.navMessage,
    };
    for (const fn of this.listeners) fn(state);
  }
}
