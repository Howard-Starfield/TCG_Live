// Public API of the console data layer (lane L4). Import from 'src/data' only, never from its files.

// Wiring
/** Creates the data layer (API client, session, stream, query cache, clock) wired together. */
export { createAdminData, useAdminData } from './admin-data';
export type { AdminData, AdminDataOptions } from './admin-data';
/** Provides AdminData, its QueryClient and server clock; starts the session and stream while mounted. */
export { AdminDataProvider } from './provider';

// API client and errors
/** Typed `/api/v1` client; rejects with ApiError (aborts rethrown unchanged). */
export { createApiClient } from './client';
export type { ApiClient, ApiClientOptions, AuditPageQuery, FetchLike, RequestOptions } from './client';
/** Typed API failure: `code`, `status` (0 = no response), `message`, optional `snapshot` and `retryAfterMs`. */
export { ApiError, isAbortError } from './errors';
export type { ApiErrorCode } from './errors';

// Session
/** Session state machine and its actions (login, logout, rotateLink, retry, hasCapability). */
export { useSession } from './hooks';
export type { SessionApi } from './hooks';
/** Session controller, fragment-login helpers and the sessionStorage token key. */
export { SessionController, SESSION_TOKEN_KEY, consumeLoginFragment, launchTokenFromInput } from './session';
export type { SessionState, SignedOutReason } from './session';

// Stream
/** Live stream connection: state (`connecting|live|reconnecting|offline|signed-out`), active event, reconnect(). */
export { useStreamConnection } from './hooks';
/** fetch-based SSE stream client with resume, watchdog, backoff and build checks. */
export { StreamClient, backoffDelay, STREAM_WATCHDOG_MS, STREAM_BACKOFF_BASE_MS, STREAM_BACKOFF_MAX_MS } from './stream';
export type { ConnectionState, StreamConnection, StreamEventInfo, StreamClientOptions } from './stream';
/** Incremental text/event-stream parser. */
export { SseParser } from './sse';
export type { SseMessage } from './sse';

// Queries
/** Query keys, the QueryClient factory, and the stream-to-cache reducer. */
export { adminKeys, createAdminQueryClient, applyStreamEvent, isSnapshotNewer } from './cache';
/** Runtime status (stream-fed after the first fetch). */
export { useRuntimeStatus } from './hooks';
/** Session-backed events, newest first. */
export { useEvents } from './hooks';
/** The active event's ID (stream, else events list), or null. */
export { useActiveEventId } from './hooks';
/** One event's snapshot (stream-fed when active, HTTP when retired). */
export { useEventSnapshot } from './hooks';
/** The active event's snapshot with a `none|loading|ready|error` status. */
export { useActiveSnapshot } from './hooks';
export type { ActiveSnapshot } from './hooks';
/** An event's audit log: stream-fed for the active event, paged HTTP for retired (fetchOlder/fetchMore). */
export { useAudit } from './hooks';
export type { AuditView } from './hooks';
/** Audit cache helpers (merge, dedupe, stream append/replace). */
export { mergeAuditEntries, applyStreamAudit, auditHasOlder, EMPTY_AUDIT_LOG } from './audit-log';
export type { AuditLog } from './audit-log';

// Clock
/** Stable function returning estimated server time; pass as the canvas `getServerNow` prop. */
export { getServerNow, serverClock, ServerClock, ServerClockContext } from './clock';
/** Server time hook (ticks per second by default), offset hook, and the clock in scope. */
export { useServerNow, useServerOffset, useServerClock } from './clock';
/** Countdown for a match clock, ticking once per displayed second only while running. */
export { useMatchCountdown } from './clock';
export type { MatchCountdown } from './clock';

// Formatting
/** Audit entry → `{ actorLabel, actorName, actorMemberId, text, tone, icon }`, named from the snapshot. */
export { formatAuditEntry, memberName, seatLabel } from './format';
export type { FormattedAuditEntry, AuditTone, AuditIconKey, AuditNameSource } from './format';
/** Relative and absolute time helpers. */
export { formatRelativeTime, formatElapsed, formatTimeOfDay, relativeTimeRefreshMs } from './format';

// Preferences
/** Persisted console preferences (`tcg-admin.prefs.v1`), synced across tabs. */
export { usePreferences, updatePreferences, resetPreferences, preferencesStore, PreferencesStore,
  DEFAULT_PREFERENCES, PREFERENCES_KEY, sanitizePreferences } from './preferences';
export type { Preferences, PreferencesPatch, ThemePreference, ListTab, CanvasView } from './preferences';

// Storage
/** Exception-safe storage wrappers. */
export { createMemoryStorage, safeStorage, browserSessionStorage, browserLocalStorage } from './storage';
export type { KeyValueStorage } from './storage';
