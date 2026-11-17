import type { DisplayMode } from '../core/types';

export const SCREEN = { w: 576, h: 288 };

export interface Box {
  id: number;
  name: string;
  kind: 'text' | 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  /** Receives touchpad events. Exactly one per layout. */
  capture?: boolean;
}

// The G2 display floats slightly above the wearer's line of sight, so everything is packed into
// one cluster in the lower middle of the canvas: closest to the road, nothing out at the edges,
// and readable in a single glance. Speed sits dead centre, with the turn on its left and the
// limit on its right, like a car HUD.
//
// Image containers stay within 200×100, the limit documented for the G2.
// The full-screen text box sits behind everything purely to capture touch events.
const EVENTS: Box = { id: 1, name: 'evt', kind: 'text', x: 0, y: 0, w: SCREEN.w, h: SCREEN.h, capture: true };

const BAND_Y = 160;

const LAYOUTS: Record<DisplayMode, Box[]> = {
  full: [
    EVENTS,
    { id: 2, name: 'info', kind: 'text', x: 68, y: 120, w: 440, h: 40 },
    { id: 3, name: 'turn', kind: 'image', x: 68, y: BAND_Y, w: 120, h: 100 },
    { id: 4, name: 'speed', kind: 'image', x: 188, y: BAND_Y, w: 200, h: 100 },
    { id: 5, name: 'limit', kind: 'image', x: 388, y: BAND_Y, w: 120, h: 100 },
    // Fourth and last image container the glasses allow; sits above `info`, clear of the main cluster.
    // id 6 (not 7): reuses the id 'text' mode uses, since the two layouts are never active at once,
    // keeping ids 1–6 contiguous — some IDs skipped straight to a non-contiguous 7 and never rendered
    // on real hardware, which a contiguous, array-indexed container table on the device side would explain.
    { id: 6, name: 'minimap', kind: 'image', x: SCREEN.w - 100 - 12, y: 12, w: 100, h: 100 },
  ],
  minimal: [
    EVENTS,
    { id: 4, name: 'speed', kind: 'image', x: 128, y: BAND_Y, w: 200, h: 100 },
    { id: 5, name: 'limit', kind: 'image', x: 328, y: BAND_Y, w: 120, h: 100 },
  ],
  text: [{ id: 6, name: 'text', kind: 'text', x: 128, y: 150, w: 320, h: 110, capture: true }],
};

export const layoutFor = (mode: DisplayMode): Box[] => LAYOUTS[mode];
