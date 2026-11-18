import { drawLimit, drawMinimap, drawSpeed, drawTurn } from './draw';
import { LAYOUT, type Box } from './layout';
import type { HudView } from './view';

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
  private started = false;
  /** Last content key sent per container id. */
  private sent = new Map<number, string>();
  private lastView: HudView | null = null;
  /** When each container was last sent, for `minInterval`. */
  private sentAt = new Map<number, number>();

  addSink(sink: HudSink): void {
    this.sinks.push(sink);
    if (this.started) {
      sink.setLayout(this.boxes);
      this.redraw();
    }
  }

  /** Lay out the HUD on every sink. Called once; there is a single fixed layout. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.boxes = LAYOUT;
    for (const s of this.sinks) s.setLayout(this.boxes);
    this.redraw();
  }

  /** Forget what was sent and push everything again (e.g. after the glasses page was rebuilt). */
  redraw(): void {
    this.sent.clear();
    this.sentAt.clear();
    if (this.lastView) this.render(this.lastView);
  }

  render(view: HudView): void {
    this.lastView = view;
    for (const box of this.boxes) {
      const [key, make] = this.content(box, view);
      if (this.sent.get(box.id) === key) continue;
      // Throttled boxes catch up on a later render, since `sent` still holds the old key.
      const now = Date.now();
      if (box.minInterval && this.sent.has(box.id) && now - (this.sentAt.get(box.id) ?? 0) < box.minInterval) continue;
      this.sent.set(box.id, key);
      this.sentAt.set(box.id, now);
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
      case 'minimap': {
        // Round points so small GPS jitter doesn't repaint the image every tick.
        const key = v.minimap ? minimapKey(v.minimap) : '';
        return [key, () => drawMinimap(v.minimap)];
      }
      case 'info':
        return [v.info];
      default:
        return [' '];
    }
  }
}

const pts = (points: { x: number; y: number }[]) => points.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(' ');

function minimapKey(m: NonNullable<HudView['minimap']>): string {
  return [
    m.scale,
    m.headingKnown,
    pts(m.route),
    m.roads.map((r) => (r.major ? 'M' : 'm') + pts(r.points)).join('|'),
    m.turn && pts([m.turn]),
    m.dest && pts([m.dest]),
    pts(m.cameras),
  ].join('/');
}
