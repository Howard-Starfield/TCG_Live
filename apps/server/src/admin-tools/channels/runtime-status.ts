// Process-local status board shared by the stickies/tickets Discord feature and the admin-tools routes
// (both run in the same process). Never persisted: after a restart the feature reports again.
import type { StickyRuntimeStatus } from './types.js';

export interface TicketPanelResult { ok: boolean; messageId: string | null; message: string }
export type TicketPanelRefresher = () => Promise<TicketPanelResult>;

export class StickiesTicketsRuntime {
  private readonly stickies = new Map<string, StickyRuntimeStatus>();
  private refresher: TicketPanelRefresher | null = null;
  panel: StickyRuntimeStatus | null = null;

  stickyStatus(id: string): StickyRuntimeStatus | null { return this.stickies.get(id) ?? null; }
  setStickyStatus(id: string, status: StickyRuntimeStatus | null): void {
    if (status) this.stickies.set(id, status); else this.stickies.delete(id);
  }
  /** The running feature registers how to (re)post the ticket panel; the route calls it. */
  registerPanelRefresher(refresher: TicketPanelRefresher | null): () => void {
    this.refresher = refresher;
    return () => { if (this.refresher === refresher) this.refresher = null; };
  }
  panelRefresher(): TicketPanelRefresher | null { return this.refresher; }
  reset(): void { this.stickies.clear(); this.refresher = null; this.panel = null; }
}

/** The single in-process board (routes and feature of one runtime). */
export const stickiesTicketsRuntime = new StickiesTicketsRuntime();
