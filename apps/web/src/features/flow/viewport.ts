// Pure viewport maths for the canvas: which orientation suits the pane, and where to put the camera.
// The pane is often a narrow, tall dock; fitting a wide graph into it would shrink text to a few
// pixels, so the automatic fit never goes below a readable zoom and pans to the action instead.
import type { FlowGraph, FlowOrientation, FlowRect } from './types';

export interface PaneSize { width: number; height: number }
export interface Viewport { x: number; y: number; zoom: number }
export interface Padding { top: number; right: number; bottom: number; left: number }

/**
 * The lowest automatic zoom: 11.5 px step titles and 12 px stage and match titles render at 11 px or
 * more. Below it the canvas pans (centred on the action) rather than shrinking further.
 */
export const READABLE_ZOOM = 0.96;
/** Never blow small graphs up beyond this. */
export const MAX_FIT_ZOOM = 1.15;
/** Room for the view switcher (top) and the zoom controls (bottom), in screen pixels. */
export const PANE_PADDING: Padding = { top: 48, right: 14, bottom: 48, left: 14 };

/** The zoom at which `bounds` fits the pane inside `padding`, capped at `MAX_FIT_ZOOM`. */
export function fitZoom(bounds: FlowRect, pane: PaneSize, padding: Padding = PANE_PADDING): number {
  const width = Math.max(1, pane.width - padding.left - padding.right);
  const height = Math.max(1, pane.height - padding.top - padding.bottom);
  if (bounds.width <= 0 || bounds.height <= 0) return 1;
  return Math.min(MAX_FIT_ZOOM, width / bounds.width, height / bounds.height);
}

/**
 * Left to right is the canonical reading; it is kept whenever it fits at a readable zoom. Otherwise
 * the orientation that fits larger wins (a tall dock pane usually prefers top to bottom).
 */
export function chooseOrientation(pane: PaneSize | null, horizontal: FlowRect, vertical: FlowRect,
  padding: Padding = PANE_PADDING): FlowOrientation {
  if (!pane || pane.width <= 0 || pane.height <= 0) return 'horizontal';
  const across = fitZoom(horizontal, pane, padding);
  if (across >= READABLE_ZOOM) return 'horizontal';
  return fitZoom(vertical, pane, padding) > across ? 'vertical' : 'horizontal';
}

function axisOffset(start: number, size: number, focus: number, zoom: number, padStart: number, available: number): number {
  const scaled = size * zoom;
  if (scaled <= available) return padStart + (available - scaled) / 2 - start * zoom;
  // Too big: centre the focus, but never leave empty space before the first or after the last node.
  const centred = padStart + available / 2 - focus * zoom;
  const lowest = padStart + available - (start + size) * zoom;
  const highest = padStart - start * zoom;
  return Math.min(highest, Math.max(lowest, centred));
}

/**
 * Camera for a graph. `minZoom` is the floor of the automatic fit (`READABLE_ZOOM`); pass 0 to show
 * everything however small (the Fit view button).
 */
export function computeViewport(graph: Pick<FlowGraph, 'bounds' | 'focus'>, pane: PaneSize,
  minZoom: number = READABLE_ZOOM, padding: Padding = PANE_PADDING): Viewport {
  const { bounds } = graph;
  const zoom = Math.max(minZoom, fitZoom(bounds, pane, padding));
  const focus = graph.focus ?? { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  const width = Math.max(1, pane.width - padding.left - padding.right);
  const height = Math.max(1, pane.height - padding.top - padding.bottom);
  return {
    x: axisOffset(bounds.x, bounds.width, focus.x, zoom, padding.left, width),
    y: axisOffset(bounds.y, bounds.height, focus.y, zoom, padding.top, height),
    zoom
  };
}
