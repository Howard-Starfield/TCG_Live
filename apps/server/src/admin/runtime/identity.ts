import type { MemberDto, Snowflake } from '@tcg-live/core';

export interface MemberProfile { displayName: string | null; avatarUrl: string | null }
/** Fetches one member by ID (REST). Resolves null when the user is unknown; rejects on transient failure. */
export type MemberFetcher = (id: Snowflake) => Promise<MemberProfile | null>;

export interface IdentityCacheOptions {
  ttlMs?: number;
  missTtlMs?: number;
  timeoutMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface Entry { value: MemberDto; expiresAtMs: number }

/**
 * Display names and avatars for snapshot members. Single-member fetches only, cached for 5 minutes:
 * no bulk member requests and no extra gateway intents. Stale values are served while a refresh fails.
 */
export class IdentityCache {
  private readonly entries = new Map<Snowflake, Entry>();
  private readonly inflight = new Map<Snowflake, Promise<void>>();
  private fetcher: MemberFetcher | null = null;
  private readonly ttlMs: number;
  private readonly missTtlMs: number;
  private readonly timeoutMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: IdentityCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.missTtlMs = options.missTtlMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.maxEntries = options.maxEntries ?? 1_000;
    this.now = options.now ?? Date.now;
  }

  attach(fetcher: MemberFetcher | null): void {
    this.fetcher = fetcher;
  }

  get(id: Snowflake): MemberDto | undefined {
    return this.entries.get(id)?.value;
  }

  /** Ensures fresh entries for `ids`; never rejects. */
  async resolve(ids: readonly Snowflake[]): Promise<void> {
    const fetcher = this.fetcher;
    if (!fetcher) return;
    const now = this.now();
    await Promise.all([...new Set(ids)].map(id => {
      const entry = this.entries.get(id);
      if (entry && entry.expiresAtMs > now) return undefined;
      let task = this.inflight.get(id);
      if (!task) {
        task = this.fetchOne(fetcher, id).finally(() => this.inflight.delete(id));
        this.inflight.set(id, task);
      }
      return task;
    }));
  }

  private async fetchOne(fetcher: MemberFetcher, id: Snowflake): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const profile = await Promise.race([
        fetcher(id),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('identity timeout')), this.timeoutMs);
        })
      ]);
      this.store(id, profile ? { id, displayName: profile.displayName, avatarUrl: profile.avatarUrl }
        : { id, displayName: null, avatarUrl: null }, profile ? this.ttlMs : this.missTtlMs);
    } catch {
      // Keep a stale value; otherwise remember the miss briefly so a failing REST call is not hammered.
      const stale = this.entries.get(id);
      this.store(id, stale?.value ?? { id, displayName: null, avatarUrl: null }, this.missTtlMs);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private store(id: Snowflake, value: MemberDto, ttlMs: number): void {
    this.entries.delete(id);
    this.entries.set(id, { value, expiresAtMs: this.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
