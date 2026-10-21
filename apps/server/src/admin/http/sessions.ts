import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError } from './respond.js';

export const SESSION_IDLE_MS = 2 * 60 * 60_000;
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60_000;
export const LOGIN_WINDOW_MS = 60_000;
/** Failed launch-token attempts allowed per window, across all clients. */
export const LOGIN_MAX_FAILURES = 10;
/** All launch-token attempts allowed per window, bounding session churn. */
export const LOGIN_MAX_ATTEMPTS = 60;
export const MAX_SESSIONS = 32;

export interface Session {
  /** Hex SHA-256 of the bearer token; the token itself is never stored. */
  readonly id: string;
  readonly createdAtMs: number;
  lastActiveMs: number;
  openStreams: number;
}

export interface SessionStoreOptions {
  port: number;
  now: () => number;
  fixedLoginToken?: string | null;
  /** Called when a session ends by expiry or eviction (not by logout). */
  onExpire: (session: Session) => void;
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
export const newToken = () => randomBytes(32).toString('base64url');
const BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/;

export class SessionStore {
  private launchToken: string;
  private launchDigest: Buffer;
  private readonly sessions = new Map<string, Session>();
  private attempts: { atMs: number; failed: boolean }[] = [];

  constructor(private readonly options: SessionStoreOptions) {
    this.launchToken = options.fixedLoginToken || newToken();
    this.launchDigest = digest(this.launchToken);
  }

  loginUrl(): string {
    return `http://127.0.0.1:${this.options.port}/#login=${this.launchToken}`;
  }

  rotate(): string {
    this.launchToken = newToken();
    this.launchDigest = digest(this.launchToken);
    return this.loginUrl();
  }

  /** Exchanges the launch token for a fresh bearer token. */
  login(candidate: string): { token: string; session: Session } {
    const now = this.options.now();
    this.attempts = this.attempts.filter(attempt => attempt.atMs > now - LOGIN_WINDOW_MS);
    if (this.attempts.filter(attempt => attempt.failed).length >= LOGIN_MAX_FAILURES || this.attempts.length >= LOGIN_MAX_ATTEMPTS) {
      throw new HttpError(429, 'too_many_requests', 'Too many sign-in attempts. Try again in a minute.', { 'Retry-After': 60 });
    }
    const ok = timingSafeEqual(digest(candidate), this.launchDigest);
    this.attempts.push({ atMs: now, failed: !ok });
    if (!ok) throw new HttpError(401, 'unauthenticated', 'The console link is invalid or has been replaced.');
    const token = newToken();
    const session: Session = { id: digest(token).toString('hex'), createdAtMs: now, lastActiveMs: now, openStreams: 0 };
    this.sessions.set(session.id, session);
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.values().next().value!;
      this.sessions.delete(oldest.id);
      this.options.onExpire(oldest);
    }
    return { token, session };
  }

  /** The live session named by an `Authorization` header, refreshed as activity; null otherwise. */
  authenticate(header: string | undefined): Session | null {
    const match = typeof header === 'string' ? BEARER.exec(header) : null;
    if (!match) return null;
    const session = this.sessions.get(digest(match[1]!).toString('hex'));
    if (!session) return null;
    const now = this.options.now();
    if (this.expired(session, now)) {
      this.end(session);
      return null;
    }
    session.lastActiveMs = now;
    return session;
  }

  revoke(session: Session): void {
    this.sessions.delete(session.id);
  }

  isLive(session: Session): boolean {
    return this.sessions.get(session.id) === session;
  }

  expiry(session: Session): { expiresAtMs: number; idleExpiresAtMs: number } {
    const expiresAtMs = session.createdAtMs + SESSION_ABSOLUTE_MS;
    const active = session.openStreams > 0 ? this.options.now() : session.lastActiveMs;
    return { expiresAtMs, idleExpiresAtMs: Math.min(expiresAtMs, active + SESSION_IDLE_MS) };
  }

  streamOpened(session: Session): void {
    session.openStreams += 1;
    session.lastActiveMs = this.options.now();
  }

  streamClosed(session: Session): void {
    session.openStreams = Math.max(0, session.openStreams - 1);
    session.lastActiveMs = Math.max(session.lastActiveMs, this.options.now());
  }

  /** Ends every expired session; an open stream counts as activity. */
  sweep(): void {
    const now = this.options.now();
    for (const session of [...this.sessions.values()]) {
      if (this.expired(session, now)) this.end(session);
      else if (session.openStreams > 0) session.lastActiveMs = now;
    }
  }

  private expired(session: Session, now: number): boolean {
    if (now >= session.createdAtMs + SESSION_ABSOLUTE_MS) return true;
    return session.openStreams === 0 && now >= session.lastActiveMs + SESSION_IDLE_MS;
  }

  private end(session: Session): void {
    this.sessions.delete(session.id);
    this.options.onExpire(session);
  }
}
