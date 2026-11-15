import type { ManeuverIcon } from '../core/types';

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

/** Large speed readout with the unit beside it; boxed when over the limit. */
export function drawSpeed(speed: string, unit: string, over: boolean): HTMLCanvasElement {
  const [c, ctx] = canvas(200, 100);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'right';
  ctx.font = `bold 84px ${FONT}`;
  ctx.fillText(speed, 138, 82, 126);
  ctx.textAlign = 'left';
  ctx.font = `600 20px ${FONT}`;
  ctx.fillText(unit, 144, 82, 50);
  if (over) {
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(3, 3, 194, 94, 14);
    ctx.stroke();
  }
  return c;
}

/** Round speed-limit sign. A null limit draws nothing (blank bitmap). */
export function drawSign(limit: number | null, over: boolean): HTMLCanvasElement {
  const [c, ctx] = canvas(96, 96);
  if (limit == null) return c;
  ctx.lineWidth = over ? 12 : 7;
  ctx.beginPath();
  ctx.arc(48, 48, 48 - ctx.lineWidth / 2 - 1, 0, Math.PI * 2);
  ctx.stroke();
  const text = String(limit);
  ctx.font = `bold ${text.length > 2 ? 34 : 44}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 48, 51);
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

/** Turn arrow for the next manoeuvre. Null draws nothing. */
export function drawArrow(icon: ManeuverIcon | null): HTMLCanvasElement {
  const [c, ctx] = canvas(96, 96);
  if (!icon) return c;
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
    return c;
  }
  if (icon === 'uturn') {
    ctx.beginPath();
    ctx.moveTo(66, 88);
    ctx.lineTo(66, 44);
    ctx.arc(48, 44, 18, 0, Math.PI, true);
    ctx.lineTo(30, 58);
    ctx.stroke();
    arrowHead(ctx, [30, 44], [30, 58]);
    return c;
  }
  if (icon === 'roundabout') {
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(48, 40, 18, 0, Math.PI * 2);
    ctx.moveTo(48, 58);
    ctx.lineTo(48, 90);
    ctx.stroke();
    arrowHead(ctx, [56, 22], [66, 22], 12);
    return c;
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
