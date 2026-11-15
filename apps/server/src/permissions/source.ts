import type { PermissionReportDto, PermissionSummaryDto } from '@tcg-live/core';

/** What the admin-tools routes and the runtimes need from a PermissionMonitor. */
export interface PermissionReportSource {
  /** The last report, or null before the first check. */
  current(): PermissionReportDto | null;
  /** Checks now. */
  recheck(): Promise<PermissionReportDto>;
  /** Debounced re-check after a settings or feature-data change. */
  schedule?(): void;
}

/** What a runtime's status() needs: the pushed summary and a change notification. */
export interface PermissionSummarySource {
  summary(): PermissionSummaryDto | null;
  subscribe(listener: () => void): () => void;
}
