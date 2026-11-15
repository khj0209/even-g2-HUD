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

// Image containers are kept within 200×100, the limit documented for the G2.
// The full-screen text box sits behind everything purely to capture touch events.
const EVENTS: Box = { id: 1, name: 'evt', kind: 'text', x: 0, y: 0, w: SCREEN.w, h: SCREEN.h, capture: true };

const LAYOUTS: Record<DisplayMode, Box[]> = {
  full: [
    EVENTS,
    { id: 2, name: 'arrow', kind: 'image', x: 4, y: 4, w: 96, h: 96 },
    { id: 3, name: 'nav', kind: 'text', x: 108, y: 0, w: 360, h: 104 },
    { id: 4, name: 'sign', kind: 'image', x: 476, y: 4, w: 96, h: 96 },
    { id: 5, name: 'speed', kind: 'image', x: 188, y: 184, w: 200, h: 100 },
    { id: 6, name: 'status', kind: 'text', x: 4, y: 244, w: 180, h: 40 },
    { id: 7, name: 'alert', kind: 'text', x: 400, y: 208, w: 172, h: 76 },
  ],
  minimal: [
    EVENTS,
    { id: 5, name: 'speed', kind: 'image', x: 188, y: 184, w: 200, h: 100 },
    { id: 4, name: 'sign', kind: 'image', x: 400, y: 186, w: 96, h: 96 },
  ],
  text: [{ id: 8, name: 'text', kind: 'text', x: 0, y: 176, w: SCREEN.w, h: 112, capture: true }],
};

export const layoutFor = (mode: DisplayMode): Box[] => LAYOUTS[mode];
