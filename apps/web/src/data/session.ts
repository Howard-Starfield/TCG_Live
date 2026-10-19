import type { Capability, SessionDto } from '@tcg-live/core';
import type { ApiClient } from './client';
import { ApiError, isAbortError } from './errors';
import type { KeyValueStorage } from './storage';

/** sessionStorage key of the bearer token (never localStorage, never a cookie). */
export const SESSION_TOKEN_KEY = 'tcg-admin.session.v1';

/** Why the console is signed out. */
export type SignedOutReason = 'no-session' | 'logged-out' | 'expired';

/** The session state machine. */
export type SessionState =
  | { status: 'signed-out'; reason: SignedOutReason }
  | { status: 'signing-in' }
  | { status: 'signed-in'; session: SessionDto }
  | { status: 'error'; error: ApiError };

/** Minimal `location`/`history` surface for the fragment login; injectable for tests. */
export interface LocationLike { hash: string; pathname: string; search: string }
export interface HistoryLike { state: unknown; replaceState(data: unknown, unused: string, url?: string | null): void }

/**
 * Reads `#login=<token>` and strips it from the URL and history synchronously. Other fragment
 * parameters are kept. Returns the launch token, or null when the fragment has none.
 */
export function consumeLoginFragment(location: LocationLike, history: HistoryLike): string | null {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  if (!params.has('login')) return null;
  const token = params.get('login')?.trim() ?? '';
  params.delete('login');
  const rest = params.toString();
  history.replaceState(history.state, '', `${location.pathname}${location.search}${rest ? `#${rest}` : ''}`);
  return token || null;
}

/** Accepts a full console link (`…#login=<token>`) or a bare launch token. */
export function launchTokenFromInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const hashIndex = trimmed.indexOf('#');
  if (hashIndex !== -1) {
    const token = new URLSearchParams(trimmed.slice(hashIndex + 1)).get('login')?.trim();
    return token || null;
  }
  return /^[A-Za-z0-9_\-.~+/=]+$/.test(trimmed) ? trimmed : null;
}

export interface SessionControllerOptions {
  api: Pick<ApiClient, 'createSession' | 'getSession' | 'deleteSession' | 'rotateLink'>;
  storage: KeyValueStorage;
  location?: LocationLike | null;
  history?: HistoryLike | null;
}

/** Owns the bearer token and the session state machine. */
export class SessionController {
  private state: SessionState = { status: 'signed-out', reason: 'no-session' };
  private readonly listeners = new Set<() => void>();
  private attempt = 0;
  private bootstrapped = false;
  private lastLaunchToken: string | null = null;

  constructor(private readonly options: SessionControllerOptions) {}

  /** Current state (stable reference until it changes). */
  readonly getState = (): SessionState => this.state;

  /** Subscribes to state changes. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** The bearer token for API calls, or null. */
  readonly getToken = (): string | null => this.options.storage.getItem(SESSION_TOKEN_KEY);

  private setState(next: SessionState): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  /**
   * First-run bootstrap; later calls return the same promise's work as a no-op. A `#login=` fragment
   * is stripped from history synchronously, before any await, then exchanged for a session.
   * Otherwise a stored token is validated with `GET /session`.
   */
  bootstrap(): Promise<void> {
    if (this.bootstrapped) return Promise.resolve();
    this.bootstrapped = true;
    const location = this.options.location === undefined
      ? (typeof window === 'undefined' ? null : window.location) : this.options.location;
    const history = this.options.history === undefined
      ? (typeof window === 'undefined' ? null : window.history) : this.options.history;
    const launchToken = location && history ? consumeLoginFragment(location, history) : null;
    if (launchToken) return this.exchange(launchToken);
    return this.validate();
  }

  /** Signs in with a pasted console link or launch token. */
  login(linkOrToken: string): Promise<void> {
    const token = launchTokenFromInput(linkOrToken);
    if (!token) {
      this.setState({ status: 'error', error: new ApiError({ code: 'bad_request', status: 400,
        message: 'Paste the console link printed in the server terminal.' }) });
      return Promise.resolve();
    }
    return this.exchange(token);
  }

  /** Retries after an error: re-sends the last launch token, or re-validates the stored token. */
  retry(): Promise<void> {
    if (this.state.status !== 'error') return Promise.resolve();
    return this.lastLaunchToken ? this.exchange(this.lastLaunchToken) : this.validate();
  }

  /** Ends the session on the server (best effort) and forgets the token. */
  async logout(): Promise<void> {
    const attempt = ++this.attempt;
    if (this.getToken()) {
      try {
        await this.options.api.deleteSession();
      } catch {
        // The token is dropped locally either way; an unreachable server expires it on its own.
      }
    }
    // A sign-in started meanwhile wins over this logout.
    if (attempt !== this.attempt && (this.state.status === 'signing-in' || this.state.status === 'signed-in')) return;
    this.options.storage.removeItem(SESSION_TOKEN_KEY);
    this.lastLaunchToken = null;
    this.setState({ status: 'signed-out', reason: 'logged-out' });
  }

  /** Asks the server to print a fresh console link; the old launch token stops working. */
  async rotateLink(): Promise<void> {
    await this.options.api.rotateLink();
  }

  /**
   * Called on any 401 from an authenticated request: forget the token and sign out. A 401 for a
   * request sent with an older token (one replaced by a new sign-in) is ignored.
   */
  handleUnauthorized(tokenUsed?: string | null): void {
    if (tokenUsed !== undefined && tokenUsed !== this.getToken()) return;
    this.attempt += 1;
    this.options.storage.removeItem(SESSION_TOKEN_KEY);
    if (this.state.status === 'signed-out') return;
    this.setState({ status: 'signed-out', reason: 'expired' });
  }

  /** True when signed in with `capability`. */
  hasCapability(capability: Capability): boolean {
    return this.state.status === 'signed-in' && this.state.session.capabilities.includes(capability);
  }

  private async exchange(launchToken: string): Promise<void> {
    const attempt = ++this.attempt;
    this.lastLaunchToken = launchToken;
    this.setState({ status: 'signing-in' });
    try {
      const grant = await this.options.api.createSession(launchToken);
      if (attempt !== this.attempt) return;
      this.options.storage.setItem(SESSION_TOKEN_KEY, grant.token);
      this.lastLaunchToken = null;
      this.setState({ status: 'signed-in', session: grant.session });
    } catch (error) {
      if (attempt !== this.attempt || isAbortError(error)) return;
      this.setState({ status: 'error', error: toApiError(error) });
    }
  }

  private async validate(): Promise<void> {
    const attempt = ++this.attempt;
    if (!this.getToken()) {
      this.setState({ status: 'signed-out', reason: 'no-session' });
      return;
    }
    this.setState({ status: 'signing-in' });
    try {
      const session = await this.options.api.getSession();
      if (attempt !== this.attempt) return;
      this.setState({ status: 'signed-in', session });
    } catch (error) {
      if (attempt !== this.attempt || isAbortError(error)) return;
      const apiError = toApiError(error);
      if (apiError.status === 401) {
        this.handleUnauthorized();
        return;
      }
      this.setState({ status: 'error', error: apiError });
    }
  }
}

function toApiError(error: unknown): ApiError {
  return error instanceof ApiError ? error
    : new ApiError({ code: 'internal', status: 0, message: 'Sign-in failed unexpectedly.', cause: error });
}
