// Public surface of the console UI kit (lane L3). Feature code imports from 'ui' only through this file.
export { cx, mergeRefs, focusableWithin } from './cx';
export { springs, variants, instant, reducedVariants, useReducedMotionSafe, useSafeTransition, useSafeVariants } from './motion';
export { useScrollPin, distanceFromBottom, type ScrollPin, type ScrollPinOptions } from './hooks/useScrollPin';
export { useRovingFocus, nextRovingIndex, type RovingFocusOptions, type RovingItemProps, type RovingOrientation } from './hooks/useRovingFocus';
export { useBackoff, backoffDelay, type Backoff, type BackoffOptions } from './hooks/useBackoff';

export { Portal, PortalScope, usePortalContainer } from './Portal';
export { computePosition, useFloating, useDismiss, useEscapeLayer, type Placement, type FloatingPosition } from './floating';
export { ThemeProvider, useResolvedTheme, useThemePreference, useSystemTheme, type ThemePreference, type ResolvedTheme, type ThemeProviderProps } from './ThemeProvider';

export { Button, IconButton, type ButtonProps, type IconButtonProps, type ButtonVariant, type ButtonSize } from './Button';
export { SegmentedControl, type SegmentedControlProps, type SegmentOption } from './SegmentedControl';
export { StatusDot, ConnectionPill, type StatusDotProps, type ConnectionPillProps, type ConnectionState, type Tone } from './Status';
export { Badge, Chip, CountBadge, type BadgeProps, type ChipProps } from './Badge';
export { Kbd, type KbdProps } from './Kbd';
export { Dialog, ConfirmDialog, type DialogProps, type ConfirmDialogProps } from './Dialog';
export { ScrollFade, type ScrollFadeProps } from './ScrollFade';
export { CodeBlock, type CodeBlockProps } from './CodeBlock';
export { Disclosure, type DisclosureProps } from './Disclosure';
export { DecisionCard, type DecisionCardProps, type DecisionReason } from './DecisionCard';
export { SplitPane, resolveSplitRatio, stepSplitRatio, SPLIT_DEADZONE_PX, type SplitPaneProps, type SplitDirection, type SplitBounds } from './SplitPane';
export {
  CommandComposer, findActiveToken, isComposingEvent,
  type CommandComposerProps, type ComposerTrigger, type ComposerSuggestion, type ActiveToken
} from './CommandComposer';
export { SidebarList, type SidebarListProps, type SidebarItem } from './SidebarList';
export { ToggleTab, TabStrip, TabPanel, tabId, tabPanelId, type ToggleTabProps, type TabStripProps, type TabItem, type TabPanelProps } from './Tabs';
export { Breadcrumb, type BreadcrumbProps, type BreadcrumbItem } from './Breadcrumb';
export { Tooltip, type TooltipProps } from './Tooltip';
export { ToastProvider, useToast, type ToastProviderProps, type ToastOptions, type ToastApi, type ToastTone } from './Toast';
export { DataTable, sortRows, type DataTableProps, type Column, type SortState, type SortDirection } from './DataTable';
export {
  Field, Input, Textarea, Select, Switch, useFieldControl,
  type FieldProps, type InputProps, type TextareaProps, type SelectProps, type SwitchProps
} from './Field';
export { Avatar, initialsOf, type AvatarProps, type AvatarSize } from './Avatar';
export { EmptyState, type EmptyStateProps } from './EmptyState';
export { PaneHeader, type PaneHeaderProps } from './PaneHeader';
export { Menu, Popover, type MenuProps, type MenuEntry, type PopoverProps, type TriggerProps } from './Menu';
