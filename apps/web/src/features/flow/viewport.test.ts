import { liveDispute, snapshots } from '@tcg-live/core/fixtures';
import { describe, expect, it } from 'vitest';
import { buildEventGraph, buildFlowGraph, buildMatchGraph, nodeFootprint } from './layout';
import type { FlowGraph, FlowRect } from './types';
import {
  chooseOrientation, computeViewport, fitZoom, MAX_FIT_ZOOM, PANE_PADDING, READABLE_ZOOM, type PaneSize
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
      for (const orientation of ['horizontal', 'vertical'] as const) {
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

  it('stops at the readable zoom and centres the action instead of shrinking', () => {
    const pane = { width: 300, height: 600 };
    expect(fitZoom(graph.bounds, pane)).toBeLessThan(READABLE_ZOOM);
    const viewport = computeViewport(graph, pane);
    expect(viewport.zoom).toBe(READABLE_ZOOM);
    const width = 300 - PANE_PADDING.left - PANE_PADDING.right;
    // Focus x = 300 lands in the middle of the available width, within the content's clamp.
    const centred = PANE_PADDING.left + width / 2 - 300 * READABLE_ZOOM;
    const lowest = PANE_PADDING.left + width - 400 * READABLE_ZOOM;
    expect(viewport.x).toBeCloseTo(Math.max(lowest, centred));
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

  it('a short stacked dock pane keeps the text readable and shows the live matches', () => {
    const vertical = buildEventGraph(liveDispute, 'vertical');
    const viewport = computeViewport(vertical, STACKED_DOCK);
    expect(viewport.zoom).toBeGreaterThanOrEqual(READABLE_ZOOM);
    // The focus (both matches) is on screen.
    const screenY = vertical.focus!.y * viewport.zoom + viewport.y;
    expect(screenY).toBeGreaterThan(PANE_PADDING.top);
    expect(screenY).toBeLessThan(STACKED_DOCK.height - PANE_PADDING.bottom);
  });
});
