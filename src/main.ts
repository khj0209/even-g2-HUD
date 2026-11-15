import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { App, type AppState } from './app';
import type { DisplayMode, Unit } from './core/types';
import { PreviewSink } from './hud/preview';
import { searchPlaces, type Place } from './services/routing';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// `?demo` in the URL starts the built-in demo drive, handy with the simulator.
const forceDemo = new URLSearchParams(location.search).has('demo');
const app = new App(new PreviewSink($<HTMLCanvasElement>('preview')), forceDemo);

const mode = $<HTMLSelectElement>('set-mode');
const unit = $<HTMLSelectElement>('set-unit');
const tolerance = $<HTMLSelectElement>('set-tolerance');
const camera = $<HTMLInputElement>('set-camera');
const demo = $<HTMLInputElement>('set-demo');
const results = $<HTMLUListElement>('results');
const searchInput = $<HTMLInputElement>('search-input');
const searchMessage = $('nav-message');

mode.onchange = () => app.updateSettings({ mode: mode.value as DisplayMode });
unit.onchange = () => app.updateSettings({ unit: unit.value as Unit });
tolerance.onchange = () => app.updateSettings({ overspeedTolerance: Number(tolerance.value) });
camera.onchange = () => app.updateSettings({ cameraAlerts: camera.checked });
demo.onchange = () => app.updateSettings({ demo: demo.checked });
$('nav-stop').onclick = () => app.stopNavigation();

let lastPosition: Place | null = null;
let searchError = '';

function showResults(places: Place[]): void {
  results.replaceChildren(
    ...places.map((place) => {
      const li = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = place.name;
      button.onclick = () => {
        results.replaceChildren();
        void app.navigateTo(place);
      };
      li.append(button);
      return li;
    }),
  );
}

$<HTMLFormElement>('search-form').onsubmit = async (e) => {
  e.preventDefault();
  const query = searchInput.value.trim();
  if (!query) return;
  searchError = '검색 중…';
  searchMessage.textContent = searchError;
  try {
    const places = await searchPlaces(query, lastPosition);
    showResults(places);
    searchError = places.length ? '' : '검색 결과가 없습니다';
  } catch (err) {
    searchError = err instanceof Error ? err.message : String(err);
  }
  searchMessage.textContent = searchError;
};

app.onState((s: AppState) => {
  $('pill-glasses').classList.toggle('on', s.glasses);
  $('pill-gps').classList.toggle('on', s.gps);
  mode.value = s.settings.mode;
  unit.value = s.settings.unit;
  tolerance.value = String(s.settings.overspeedTolerance);
  camera.checked = s.settings.cameraAlerts;
  demo.checked = s.settings.demo;
  searchInput.disabled = s.settings.demo;
  $('nav-active').hidden = !s.destination;
  $('nav-dest').textContent = s.destination?.name ?? '';
  searchMessage.textContent = s.navMessage || searchError || (s.settings.demo ? '데모 주행 중에는 내장 경로로 안내합니다' : '');
});

app.start();
// The SDK bridge also resolves in a plain browser, where every call would fail; only attach the
// glasses when the Even App (or simulator) host is really there. Otherwise stay preview-only.
void waitForEvenAppBridge().then((bridge) => {
  if ((window as any).flutter_inappwebview?.callHandler) return app.attachBridge(bridge);
});
