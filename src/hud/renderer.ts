import type { DisplayMode } from '../core/types';
import { drawLimit, drawSpeed, drawTurn } from './draw';
import { layoutFor, type Box } from './layout';
import { textModeLines, type HudView } from './view';

/** Somewhere the HUD can be shown: the glasses, or the on-phone preview. */
export interface HudSink {
  setLayout(boxes: Box[]): void;
  setText(box: Box, content: string): void;
  setImage(box: Box, image: HTMLCanvasElement): void;
}

/** Turns a HudView into per-container updates, sending only what changed. */
export class HudRenderer {
  private sinks: HudSink[] = [];
  private boxes: Box[] = [];
  private mode: DisplayMode | null = null;
  /** Last content key sent per container id. */
  private sent = new Map<number, string>();
  private lastView: HudView | null = null;

  addSink(sink: HudSink): void {
    this.sinks.push(sink);
    if (this.mode) {
      sink.setLayout(this.boxes);
      this.redraw();
    }
  }

  setMode(mode: DisplayMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.boxes = layoutFor(mode);
    for (const s of this.sinks) s.setLayout(this.boxes);
    this.redraw();
  }

  /** Forget what was sent and push everything again (e.g. after the glasses page was rebuilt). */
  redraw(): void {
    this.sent.clear();
    if (this.lastView) this.render(this.lastView);
  }

  render(view: HudView): void {
    this.lastView = view;
    for (const box of this.boxes) {
      const [key, make] = this.content(box, view);
      if (this.sent.get(box.id) === key) continue;
      this.sent.set(box.id, key);
      if (box.kind === 'text') for (const s of this.sinks) s.setText(box, key);
      else {
        const image = (make as () => HTMLCanvasElement)();
        for (const s of this.sinks) s.setImage(box, image);
      }
    }
  }

  /** Content key for a container, plus a painter for image containers. */
  private content(box: Box, v: HudView): [string, (() => HTMLCanvasElement)?] {
    switch (box.name) {
      case 'speed':
        return [`${v.speed}|${v.unit}|${v.over}`, () => drawSpeed(v.speed, v.unit, v.over)];
      case 'limit':
        return [`${v.limit}|${v.over}|${v.alert}`, () => drawLimit(v.limit, v.over, v.alert)];
      case 'turn':
        return [v.nav ? `${v.nav.icon}|${v.nav.dist}` : '', () => drawTurn(v.nav)];
      case 'info':
        return [v.info];
      case 'text':
        return [textModeLines(v)];
      default:
        return [' '];
    }
  }
}
