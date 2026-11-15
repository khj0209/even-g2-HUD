import type { ManeuverIcon, MinimapView } from '../core/types';

/** Bitmaps for the glasses: white on black, which the G2 shows as green on transparent. */

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = ctx.strokeStyle = '#fff';
  ctx.lineCap = ctx.lineJoin = 'round';
  return [c, ctx];
}

const FONT = 'system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';

/** Large speed readout, centred, with the unit underneath; boxed when over the limit. */
export function drawSpeed(speed: string, unit: string, over: boolean): HTMLCanvasElement {
  const [c, ctx] = canvas(200, 100);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `bold 76px ${FONT}`;
  ctx.fillText(speed, 100, 68, 180);
  ctx.font = `600 18px ${FONT}`;
  ctx.fillText(unit, 100, 91);
  if (over) {
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(3, 3, 194, 94, 14);
    ctx.stroke();
  }
  return c;
}

/** Caption under an icon in a 120×100 side block. */
function caption(ctx: CanvasRenderingContext2D, text: string): void {
  ctx.fillStyle = '#fff';
  ctx.font = `bold 22px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, 60, 95, 116);
}

/** Right-hand block: round speed-limit sign with the camera warning under it. Either may be absent. */
export function drawLimit(limit: number | null, over: boolean, alert: string): HTMLCanvasElement {
  const [c, ctx] = canvas(120, 100);
  if (limit != null) {
    ctx.lineWidth = over ? 9 : 6;
    ctx.beginPath();
    ctx.arc(60, 36, 34 - ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.stroke();
    const text = String(limit);
    ctx.font = `bold ${text.length > 2 ? 24 : 32}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 60, 38);
  }
  if (alert) caption(ctx, alert);
  return c;
}

/** Left-hand block: turn arrow with the distance to the turn under it. Null draws nothing. */
export function drawTurn(nav: { icon: ManeuverIcon; dist: string } | null): HTMLCanvasElement {
  const [c, ctx] = canvas(120, 100);
  if (!nav) return c;
  ctx.save();
  ctx.translate(60 - 35, 0);
  ctx.scale(70 / 96, 70 / 96);
  arrow(ctx, nav.icon);
  ctx.restore();
  caption(ctx, nav.dist);
  return c;
}

type Pt = [number, number];

/** Arrow shafts for right-hand manoeuvres in a 96×96 box; left-hand ones are mirrored. */
const SHAFTS: Record<string, Pt[]> = {
  straight: [[48, 88], [48, 26]],
  'slight-right': [[38, 88], [38, 56], [64, 30]],
  right: [[32, 88], [32, 44], [68, 44]],
  'sharp-right': [[34, 88], [34, 30], [64, 60]],
};

function arrowHead(ctx: CanvasRenderingContext2D, from: Pt, tip: Pt, size = 20): void {
  const a = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  // Push the head past the end of the shaft so the tip is sharp.
  const tx = tip[0] + Math.cos(a) * size * 0.6;
  const ty = tip[1] + Math.sin(a) * size * 0.6;
  ctx.beginPath();
  ctx.moveTo(tx, ty);
  ctx.lineTo(tx - Math.cos(a - 0.6) * size * 1.4, ty - Math.sin(a - 0.6) * size * 1.4);
  ctx.lineTo(tx - Math.cos(a + 0.6) * size * 1.4, ty - Math.sin(a + 0.6) * size * 1.4);
  ctx.closePath();
  ctx.fill();
}

/** Paints a manoeuvre arrow into a 96×96 box at the origin. */
function arrow(ctx: CanvasRenderingContext2D, icon: ManeuverIcon): void {
  ctx.lineWidth = 12;

  if (icon === 'arrive') {
    // Map pin.
    ctx.beginPath();
    ctx.arc(48, 36, 24, Math.PI * 0.85, Math.PI * 0.15);
    ctx.lineTo(48, 90);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.arc(48, 36, 9, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (icon === 'uturn') {
    ctx.beginPath();
    ctx.moveTo(66, 88);
    ctx.lineTo(66, 44);
    ctx.arc(48, 44, 18, 0, Math.PI, true);
    ctx.lineTo(30, 58);
    ctx.stroke();
    arrowHead(ctx, [30, 44], [30, 58]);
    return;
  }
  if (icon === 'roundabout') {
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(48, 40, 18, 0, Math.PI * 2);
    ctx.moveTo(48, 58);
    ctx.lineTo(48, 90);
    ctx.stroke();
    arrowHead(ctx, [56, 22], [66, 22], 12);
    return;
  }

  const left = icon.endsWith('left');
  if (left) {
    ctx.translate(96, 0);
    ctx.scale(-1, 1);
  }
  const pts = SHAFTS[icon.replace('left', 'right')];
  ctx.beginPath();
  ctx.moveTo(...pts[0]);
  for (const p of pts.slice(1)) ctx.lineTo(...p);
  ctx.stroke();
  arrowHead(ctx, pts[pts.length - 2], pts[pts.length - 1]);
}

/** Top-right corner box: car-centred, heading-up route line. Null (or too short) draws just the bezel. */
export function drawMinimap(mm: MinimapView | null): HTMLCanvasElement {
  const [c, ctx] = canvas(100, 100);
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(2, 2, 96, 96, 14);
  ctx.stroke();
  if (!mm) return c;

  ctx.save();
  ctx.translate(50, 50);
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(mm.points[0].x, mm.points[0].y);
  for (const p of mm.points.slice(1)) ctx.lineTo(p.x, p.y);
  ctx.stroke();

  // Car marker, centred: an arrow when heading-up (always points "up" by construction), else a plain dot.
  ctx.beginPath();
  if (mm.headingKnown) {
    ctx.moveTo(0, -8);
    ctx.lineTo(6, 7);
    ctx.lineTo(-6, 7);
    ctx.closePath();
  } else {
    ctx.arc(0, 0, 5, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.restore();
  return c;
}

/** Encode a canvas as PNG bytes for `updateImageRawData`. */
export function pngBytes(c: HTMLCanvasElement): Promise<number[]> {
  return new Promise((resolve, reject) =>
    c.toBlob(async (blob) => {
      if (!blob) return reject(new Error('PNG encode failed'));
      resolve(Array.from(new Uint8Array(await blob.arrayBuffer())));
    }, 'image/png'),
  );
}
