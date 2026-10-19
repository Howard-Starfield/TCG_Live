import { liveDispute, snapshots } from '@tcg-live/core/fixtures';
import { describe, expect, it } from 'vitest';
import { buildEventGraph, buildFlowGraph, buildMatchGraph, nodeFootprint } from './layout';
import type { FlowGraph, FlowRect } from './types';
import {
  chooseLayout, chooseOrientation, computeViewport, fitZoom, MAX_FIT_ZOOM, MIN_AUTO_ZOOM, PANE_PADDING, READABLE_ZOOM,
  type PaneSize
} from './viewport';

/** The shell's default dock is 480 px wide; a single Live pane is tall, stacked panes are short. */
const TALL_DOCK: PaneSize = { width: 466, height: 760 };
const STACKED_DOCK: PaneSize = { width: 466, height: 330 };
const WIDE: PaneSize = { width: 1000, height: 420 };

function orientationFor(pane: PaneSize, view: 'event' | 'match') {
  const across = buildFlowGraph(liveDispute, view, null, 'horizontal');
  const down = buildFlowGraph(liveDispute, view, null, 'vertical');
  return chooseOrientation(pane, across.bounds, down.bounds);
}

function overlaps(a: FlowRect, b: FlowRect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

describe('orientation', () => {
  it('keeps left to right in a wide pane and goes top to bottom in a tall dock pane', () => {
    expect(orientationFor(WIDE, 'event')).toBe('horizontal');
    expect(orientationFor(WIDE, 'match')).toBe('horizontal');
    expect(orientationFor(TALL_DOCK, 'event')).toBe('vertical');
    expect(orientationFor(TALL_DOCK, 'match')).toBe('vertical');
    expect(chooseOrientation(null, buildEventGraph(liveDispute).bounds, buildEventGraph(liveDispute, 'vertical').bounds))
      .toBe('horizontal');
  });

  it('in the default tall dock pane both views fit at a readable zoom', () => {
    for (const view of ['event', 'match'] as const) {
      const graph = buildFlowGraph(liveDispute, view, null, 'vertical');
      expect(fitZoom(graph.bounds, TALL_DOCK)).toBeGreaterThanOrEqual(READABLE_ZOOM);
      expect(computeViewport(graph, TALL_DOCK).zoom).toBeGreaterThanOrEqual(READABLE_ZOOM);
    }
  });

  it('vertical layouts carry their own keys, positions and anchors', () => {
    const across = buildEventGraph(liveDispute);
    const down = buildEventGraph(liveDispute, 'vertical');
    expect(across.layoutKey).toBe('event');
    expect(down.layoutKey).toBe('event:vertical');
    expect(down.nodes.map(node => node.id)).toEqual(across.nodes.map(node => node.id));
    expect(down.edges.find(edge => edge.id === 'round->M1')).toMatchObject({ sourceHandle: 's-bottom', targetHandle: 't-top' });
    expect(buildMatchGraph(liveDispute, 'M2', 'vertical').layoutKey).toBe('match:M2:vertical');
    // States do not depend on the orientation.
    const states = (graph: FlowGraph) => graph.nodes.map(node => [node.id, node.data.state]);
    expect(states(down)).toEqual(states(across));
    expect(states(buildMatchGraph(liveDispute, 'M2', 'vertical'))).toEqual(states(buildMatchGraph(liveDispute, 'M2')));
  });

  it('no two nodes (stage labels included) overlap in any layout', () => {
    for (const snapshot of Object.values(snapshots)) {
      for (const orientation of ['horizontal', 'vertical', 'compact', 'strip'] as const) {
        const graphs = [buildEventGraph(snapshot, orientation),
          ...snapshot.matches.map(match => buildMatchGraph(snapshot, match.id, orientation))];
        for (const graph of graphs) {
          const rects = graph.nodes.map(node => [node.id, nodeFootprint(node)] as const);
          for (const [index, [id, rect]] of rects.entries()) {
            for (const [otherId, other] of rects.slice(index + 1)) {
              expect(overlaps(rect, other), `${graph.layoutKey}: ${id} overlaps ${otherId}`).toBe(false);
            }
          }
        }
      }
    }
  });

  it('bounds cover every node and its label; focus is the centre of the live and waiting nodes', () => {
    const graph = buildEventGraph(liveDispute);
    for (const node of graph.nodes) {
      const rect = nodeFootprint(node);
      expect(rect.x).toBeGreaterThanOrEqual(graph.bounds.x);
      expect(rect.y + rect.height).toBeLessThanOrEqual(graph.bounds.y + graph.bounds.height);
    }
    // M1 (live) at y 30 and M2 (waiting) ending at 146 + 88.
    expect(graph.focus).toEqual({ x: 420 + 98, y: (30 + 146 + 88) / 2 });
    expect(buildEventGraph(snapshots.final).focus).toBeNull();
  });
});

describe('computeViewport', () => {
  const graph = { bounds: { x: 0, y: 0, width: 400, height: 200 }, focus: { x: 300, y: 150 } };

  it('fits and centres a graph that fits, never above the zoom cap', () => {
    const viewport = computeViewport(graph, { width: 1000, height: 600 });
    expect(viewport.zoom).toBe(MAX_FIT_ZOOM);
    const width = 1000 - PANE_PADDING.left - PANE_PADDING.right;
    expect(viewport.x).toBeCloseTo(PANE_PADDING.left + (width - 400 * MAX_FIT_ZOOM) / 2);
  });

  it('shows everything when that needs a zoom of at least MIN_AUTO_ZOOM', () => {
    const pane = { width: 380, height: 600 };
    const whole = fitZoom(graph.bounds, pane);
    expect(whole).toBeLessThan(READABLE_ZOOM);
    expect(whole).toBeGreaterThanOrEqual(MIN_AUTO_ZOOM);
    const viewport = computeViewport(graph, pane);
    expect(viewport.zoom).toBeCloseTo(whole);
    expect(viewport.x).toBeCloseTo(PANE_PADDING.left);
  });

  it('below the floor it stays at the floor, keeps the full width and clips vertically around the action', () => {
    // Wide enough for the whole width at 0.9, far too short for the height.
    const pane = { width: 400 * 0.9 + 28, height: 200 };
    expect(fitZoom(graph.bounds, pane)).toBeLessThan(MIN_AUTO_ZOOM);
    const viewport = computeViewport(graph, pane);
    // No zooming up to fill the width: that would only clip more of the height.
    expect(viewport.zoom).toBe(MIN_AUTO_ZOOM);
    const width = pane.width - PANE_PADDING.left - PANE_PADDING.right;
    expect(viewport.x).toBeCloseTo(PANE_PADDING.left + (width - 400 * MIN_AUTO_ZOOM) / 2);
    const room = 200 - PANE_PADDING.top - PANE_PADDING.bottom;
    const centred = PANE_PADDING.top + room / 2 - 150 * MIN_AUTO_ZOOM;
    const lowest = PANE_PADDING.top + room - 200 * MIN_AUTO_ZOOM;
    expect(viewport.y).toBeCloseTo(Math.max(lowest, centred));
  });

  it('never goes below the floor: a very narrow pane pans horizontally too', () => {
    const pane = { width: 200, height: 200 };
    const viewport = computeViewport(graph, pane);
    expect(viewport.zoom).toBe(MIN_AUTO_ZOOM);
    // Never empty space before the first node.
    expect(viewport.x).toBeLessThanOrEqual(PANE_PADDING.left);
  });

  it('the Fit view button (floor 0) shows everything however small', () => {
    const pane = { width: 300, height: 600 };
    const viewport = computeViewport(graph, pane, 0);
    expect(viewport.zoom).toBeCloseTo(fitZoom(graph.bounds, pane));
    expect(viewport.zoom).toBeLessThan(READABLE_ZOOM);
    expect(viewport.x).toBeCloseTo(PANE_PADDING.left);
  });

  const EVENT_LAYOUTS = ['horizontal', 'vertical', 'compact', 'strip'] as const;
  const eventLayouts = () => EVENT_LAYOUTS.map(orientation => buildEventGraph(liveDispute, orientation));
  const pick = (pane: PaneSize) => {
    const layouts = eventLayouts();
    const chosen = chooseLayout(pane, layouts.map(({ orientation, bounds }) => ({ orientation, bounds })));
    return layouts.find(layout => layout.orientation === chosen)!;
  };
  /** Screen rectangles of every node footprint (stage labels included). */
  const onScreen = (graph: FlowGraph, pane: PaneSize) => {
    const viewport = computeViewport(graph, pane);
    return { viewport, rects: graph.nodes.map(node => {
      const rect = nodeFootprint(node);
      const left = rect.x * viewport.zoom + viewport.x;
      const top = rect.y * viewport.zoom + viewport.y;
      return { left, top, right: left + rect.width * viewport.zoom, bottom: top + rect.height * viewport.zoom };
    }) };
  };

  // Measured in the shell: the Live pane with both panes open at 1440 x 900, and the Live pane in the
  // previews sheet at 1000 x 800 (Live and List stacked).
  for (const [name, pane, expected] of [
    ['both panes at 1440x900', { width: 460, height: 363 }, 'compact'],
    ['a slightly larger stacked pane', { width: 480, height: 380 }, 'compact'],
    ['the sheet at 1000x800', { width: 580, height: 318 }, 'strip']
  ] as const) {
    it(`${name}: shows the whole Event view, clear of the overlays, at about 10 px titles`, () => {
      const graph = pick(pane);
      expect(graph.orientation).toBe(expected);
      const { viewport, rects } = onScreen(graph, pane);
      expect(viewport.zoom).toBeGreaterThanOrEqual(MIN_AUTO_ZOOM);
      for (const rect of rects) {
        expect(rect.left).toBeGreaterThanOrEqual(PANE_PADDING.left - 0.5);
        expect(rect.top).toBeGreaterThanOrEqual(PANE_PADDING.top - 0.5);
        expect(rect.right).toBeLessThanOrEqual(pane.width - PANE_PADDING.right + 0.5);
        expect(rect.bottom).toBeLessThanOrEqual(pane.height - PANE_PADDING.bottom + 0.5);
      }
    });
  }

  it('an even shorter pane clips vertically at the floor, never horizontally', () => {
    const graph = pick(STACKED_DOCK);
    const { viewport, rects } = onScreen(graph, STACKED_DOCK);
    expect(viewport.zoom).toBe(MIN_AUTO_ZOOM);
    for (const rect of rects) {
      expect(rect.left).toBeGreaterThanOrEqual(PANE_PADDING.left - 0.5);
      expect(rect.right).toBeLessThanOrEqual(STACKED_DOCK.width - PANE_PADDING.right + 0.5);
    }
  });

  it('the strip Event layout drops every edge label and keeps the states', () => {
    const strip = buildEventGraph(liveDispute, 'strip');
    const horizontal = buildEventGraph(liveDispute);
    expect(strip.layoutKey).toBe('event:strip');
    expect(strip.edges.map(edge => edge.data!.state)).toEqual(horizontal.edges.map(edge => edge.data!.state));
    expect(strip.edges.filter(edge => edge.data!.label)).toEqual([]);
    expect(strip.bounds.width).toBeLessThan(horizontal.bounds.width);
  });

  it('the compact Event layout drops only the branch labels', () => {
    const compact = buildEventGraph(liveDispute, 'compact');
    const vertical = buildEventGraph(liveDispute, 'vertical');
    expect(compact.layoutKey).toBe('event:compact');
    expect(compact.edges.map(edge => edge.data!.state)).toEqual(vertical.edges.map(edge => edge.data!.state));
    expect(compact.edges.filter(edge => edge.data!.label).map(edge => edge.id)).toEqual(['signup->checkin', 'checkin->round']);
    expect(compact.bounds.height).toBeLessThan(vertical.bounds.height);
  });
});
