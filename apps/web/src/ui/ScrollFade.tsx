import { useCallback, useEffect, useMemo, useState, type HTMLAttributes, type Ref } from 'react';
import { cx, mergeRefs } from './cx';

export interface ScrollFadeProps extends HTMLAttributes<HTMLDivElement> {
  /** Scroll axis; the fades appear on the edges that have hidden content. */
  axis?: 'vertical' | 'horizontal';
  /** Fade length in px (default 24). */
  fade?: number;
  ref?: Ref<HTMLDivElement>;
}

/** Scroll container that softly fades its edges while more content is hidden in that direction. */
export function ScrollFade({ axis = 'vertical', fade = 24, className, style, ref, children, ...rest }: ScrollFadeProps) {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const setRefs = useMemo(() => mergeRefs(setNode, ref), [ref]);
  const [edges, setEdges] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    if (!node) return;
    const vertical = axis === 'vertical';
    const offset = vertical ? node.scrollTop : node.scrollLeft;
    const size = vertical ? node.clientHeight : node.clientWidth;
    const total = vertical ? node.scrollHeight : node.scrollWidth;
    const next = { start: offset > 1, end: offset + size < total - 1 };
    setEdges(prev => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, [axis, node]);

  useEffect(() => {
    if (!node) return;
    measure();
    node.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    if (node.firstElementChild) observer?.observe(node.firstElementChild);
    return () => {
      node.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [measure, node]);

  return (
    <div {...rest} ref={setRefs} data-axis={axis} data-fade-start={edges.start || undefined} data-fade-end={edges.end || undefined}
      style={{ ...style, ['--ui-fade' as string]: `${fade}px` }}
      className={cx('ui-scroll-fade', axis === 'vertical' ? 'overflow-y-auto overflow-x-hidden' : 'overflow-x-auto overflow-y-hidden', className)}>
      {children}
    </div>
  );
}
