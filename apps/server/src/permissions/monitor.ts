// Keeps the latest permission report: re-checks after Discord or settings changes (debounced, one check
// in flight at a time), on demand ("Re-check"), and tells listeners when the summary changed.
import { summarizePermissionIssues, type PermissionReportDto, type PermissionSummaryDto } from '@tcg-live/core';

export interface PermissionMonitorOptions {
  /** Runs one check. Rejections become an `unavailable` report from `onError`. */
  check(): Promise<PermissionReportDto>;
  onError(error: unknown): PermissionReportDto;
  debounceMs?: number;
  setTimer?(callback: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
}

export class PermissionMonitor {
  private report: PermissionReportDto | null = null;
  private timer: unknown = null;
  private running: Promise<PermissionReportDto> | null = null;
  private again = false;
  private closed = false;
  private readonly listeners = new Set<() => void>();
  private readonly debounceMs: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: PermissionMonitorOptions) {
    this.debounceMs = options.debounceMs ?? 2_000;
    this.setTimer = options.setTimer ?? ((callback, ms) => { const handle = setTimeout(callback, ms); handle.unref?.(); return handle; });
    this.clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as NodeJS.Timeout));
  }

  /** The last report, or null before the first check. */
  current(): PermissionReportDto | null { return this.report; }

  summary(): PermissionSummaryDto | null {
    const report = this.report;
    if (!report || report.checkedAtMs === null) return null;
    return summarizePermissionIssues(report.issues, report.checkedAtMs);
  }

  /** Called after every finished check (the summary carries checkedAtMs, so it always changes). Returns an unsubscribe. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Debounced re-check: many Discord events in a burst cause one check. */
  schedule(): void {
    if (this.closed) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => { this.timer = null; void this.recheck(); }, this.debounceMs);
  }

  /** Checks now (joins a check in flight, then runs once more so the answer reflects this call). */
  async recheck(): Promise<PermissionReportDto> {
    if (this.closed) return this.report ?? this.options.onError(new Error('closed'));
    if (this.running) {
      // The loop below runs once more after the check in flight, so this caller sees a fresh answer.
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        let next: PermissionReportDto;
        do {
          this.again = false;
          try { next = await this.options.check(); } catch (error) { next = this.options.onError(error); }
        } while (this.again && !this.closed);
        this.report = next;
        for (const listener of [...this.listeners]) { try { listener(); } catch { /* Listeners never fail a check. */ } }
        return next;
      } finally { this.running = null; }
    })();
    return this.running;
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    this.listeners.clear();
  }
}
