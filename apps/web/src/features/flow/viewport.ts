// Pure viewport maths for the canvas: which layout suits the pane, and where to put the camera.
// The pane is often a narrow dock column, tall (one pane) or short (Live and List stacked). Fitting a
// wide graph into it would shrink text to a few pixels, so the automatic fit:
//   1. keeps left to right while that fits at a comfortable zoom;
//   2. otherwise takes the layout that shows everything at the largest zoom, down to a relaxed floor;
//   3. only below that floor clips, at the floor, preferring a layout whose full width still fits.
import type { FlowOrientation, FlowRect } from './types';

export interface PaneSize { width: number; height: number }
export interface Viewport { x: number; y: number; zoom: number }
export interface Padding { top: number; right: number; bottom: number; left: number }

/** Comfortable zoom: titles of 11.5 to 12 px render at 11 px or more. */
export const READABLE_ZOOM = 0.96;
/** Lowest automatic zoom: titles still render at about 10 px. Below it the canvas pans instead. */
export const MIN_AUTO_ZOOM = 0.8;
/** Never blow small graphs up beyond this. */
export const MAX_FIT_ZOOM = 1.15;
/**
 * Screen pixels kept clear for the overlays: the view switcher and legend along the top (38 px with
 * their margin), the zoom controls and attribution along the bottom.
 */
export const PANE_PADDING: Padding = { top: 48, right: 14, bottom: 48, left: 14 };

function available(pane: PaneSize, padding: Padding): { width: number; height: number } {
  return {
    width: Math.max(1, pane.width - padding.left - padding.right),
    height: Math.max(1, pane.height - padding.top - padding.bottom)
  };
}

/** The zoom at which all of `bounds` fits the pane inside `padding`, capped at `MAX_FIT_ZOOM`. */
export function fitZoom(bounds: FlowRect, pane: PaneSize, padding: Padding = PANE_PADDING): number {
  if (bounds.width <= 0 || bounds.height <= 0) return 1;
  const room = available(pane, padding);
  return Math.min(MAX_FIT_ZOOM, room.width / bounds.width, room.height / bounds.height);
}

/** The zoom at which the full width of `bounds` fits, capped at `MAX_FIT_ZOOM`. */
export function fitWidthZoom(bounds: FlowRect, pane: PaneSize, padding: Padding = PANE_PADDING): number {
  if (bounds.width <= 0) return 1;
  return Math.min(MAX_FIT_ZOOM, available(pane, padding).width / bounds.width);
}

export interface LayoutCandidate { orientation: FlowOrientation; bounds: FlowRect }

/**
 * Picks a layout for the pane from `candidates` (the first is the canonical left-to-right one, kept
 * whenever it fits comfortably). Otherwise the candidate showing everything at the largest zoom wins,
 * if that zoom is at least `MIN_AUTO_ZOOM`; failing that, the one whose full width fits largest.
 * Ties keep the earlier candidate.
 */
export function chooseLayout(pane: PaneSize | null, candidates: LayoutCandidate[],
  padding: Padding = PANE_PADDING): FlowOrientation {
  const first = candidates[0];
  if (!first) return 'horizontal';
  if (!pane || pane.width <= 0 || pane.height <= 0) return first.orientation;
  if (fitZoom(first.bounds, pane, padding) >= READABLE_ZOOM) return first.orientation;
  const whole = (candidate: LayoutCandidate) => fitZoom(candidate.bounds, pane, padding);
  const across = (candidate: LayoutCandidate) => fitWidthZoom(candidate.bounds, pane, padding);
  const best = candidates.reduce((winner, candidate) => (whole(candidate) > whole(winner) ? candidate : winner));
  if (whole(best) >= MIN_AUTO_ZOOM) return best.orientation;
  // Clipping is unavoidable: prefer layouts whose full width fits at the floor (clip vertically only),
  // then the one that shows the most of itself.
  const widthFits = (candidate: LayoutCandidate) => across(candidate) >= MIN_AUTO_ZOOM;
  return candidates.reduce((winner, candidate) => {
    if (widthFits(candidate) !== widthFits(winner)) return widthFits(candidate) ? candidate : winner;
    return whole(candidate) > whole(winner) ? candidate : winner;
  }).orientation;
}

/** Two-layout form kept for callers and tests: left to right versus top to bottom. */
export function chooseOrientation(pane: PaneSize | null, horizontal: FlowRect, vertical: FlowRect,
  padding: Padding = PANE_PADDING): FlowOrientation {
  return chooseLayout(pane, [{ orientation: 'horizontal', bounds: horizontal }, { orientation: 'vertical', bounds: vertical }], padding);
}

function axisOffset(start: number, size: number, focus: number, zoom: number, padStart: number, room: number): number {
  const scaled = size * zoom;
  if (scaled <= room + 0.5) return padStart + (room - scaled) / 2 - start * zoom;
  // Too big: centre the focus, but never leave empty space before the first or after the last node.
  const centred = padStart + room / 2 - focus * zoom;
  const lowest = padStart + room - (start + size) * zoom;
  const highest = padStart - start * zoom;
  return Math.min(highest, Math.max(lowest, centred));
}

/**
 * Camera for a graph. If everything fits at `minZoom` or more, everything is shown. Otherwise the zoom
 * is `minZoom` and the camera centres the focus, clamped so no space is wasted before the first or
 * after the last node. Pass `minZoom` 0 to show everything however small (the Fit view button).
 */
export function computeViewport(graph: { bounds: FlowRect; focus: { x: number; y: number } | null }, pane: PaneSize,
  minZoom: number = MIN_AUTO_ZOOM, padding: Padding = PANE_PADDING): Viewport {
  const { bounds } = graph;
  const whole = fitZoom(bounds, pane, padding);
  const zoom = Math.max(minZoom, whole);
  const focus = graph.focus ?? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const room = available(pane, padding);
  return {
    x: axisOffset(bounds.x, bounds.width, focus.x, zoom, padding.left, room.width),
    y: axisOffset(bounds.y, bounds.height, focus.y, zoom, padding.top, room.height),
    zoom
  };
}
