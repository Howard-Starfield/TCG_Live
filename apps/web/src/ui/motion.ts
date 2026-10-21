// Spring presets for the console. Values are tuned by hand for this kit: panes settle without overshoot,
// popovers land with a hint of give, list items arrive softly. Durations collapse to zero when the user
// asks for reduced motion.
import { useReducedMotion, type Transition, type Variants } from 'motion/react';

export const springs = {
  /** Docks, split panes, sidebars: firm and overshoot-free. */
  pane: { type: 'spring', stiffness: 380, damping: 40, mass: 0.9 },
  /** Menus, tooltips, popovers: quick with a whisper of overshoot. */
  popover: { type: 'spring', stiffness: 520, damping: 36, mass: 0.8 },
  /** Dialogs: slightly heavier than popovers. */
  dialog: { type: 'spring', stiffness: 440, damping: 34, mass: 0.9 },
  /** Feed rows, toasts, suggestion items. */
  listItem: { type: 'spring', stiffness: 300, damping: 30, mass: 1 },
  /** Small controls: segmented indicator, switches. */
  control: { type: 'spring', stiffness: 640, damping: 40, mass: 0.7 }
} as const satisfies Record<string, Transition>;

export const instant: Transition = { duration: 0 };

export const variants = {
  popover: {
    hidden: { opacity: 0, scale: 0.97, y: -3 },
    shown: { opacity: 1, scale: 1, y: 0, transition: springs.popover },
    exit: { opacity: 0, scale: 0.98, transition: { duration: 0.1, ease: 'easeOut' } }
  },
  dialog: {
    hidden: { opacity: 0, scale: 0.97, y: 8 },
    shown: { opacity: 1, scale: 1, y: 0, transition: springs.dialog },
    exit: { opacity: 0, scale: 0.98, y: 4, transition: { duration: 0.14, ease: 'easeIn' } }
  },
  backdrop: {
    hidden: { opacity: 0 },
    shown: { opacity: 1, transition: { duration: 0.18 } },
    exit: { opacity: 0, transition: { duration: 0.14 } }
  },
  listItem: {
    hidden: { opacity: 0, y: 8 },
    shown: { opacity: 1, y: 0, transition: springs.listItem },
    exit: { opacity: 0, y: -4, transition: { duration: 0.14 } }
  },
  toast: {
    hidden: { opacity: 0, y: 12, scale: 0.98 },
    shown: { opacity: 1, y: 0, scale: 1, transition: springs.listItem },
    exit: { opacity: 0, x: 24, transition: { duration: 0.16, ease: 'easeIn' } }
  }
} as const satisfies Record<string, Variants>;

/** Variant set for reduced motion: no movement, only an instant state change. */
export const reducedVariants: Variants = {
  hidden: { opacity: 0, transition: instant },
  shown: { opacity: 1, transition: instant },
  exit: { opacity: 0, transition: instant }
};

/**
 * True when the user prefers reduced motion. Never null (motion returns null before it can read the media
 * query, and in environments without `matchMedia`).
 */
export function useReducedMotionSafe(): boolean {
  return useReducedMotion() === true;
}

/** Returns the transition, or an instant one when reduced motion is requested. */
export function useSafeTransition(transition: Transition): Transition {
  return useReducedMotionSafe() ? instant : transition;
}

/** Returns the variants, or opacity-only instant variants when reduced motion is requested. */
export function useSafeVariants(set: Variants): Variants {
  return useReducedMotionSafe() ? reducedVariants : set;
}
