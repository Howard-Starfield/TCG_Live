// Process-local LFG status board shared by the Discord feature and the routes (same process). Never persisted.
import type { LfgPanelStatusDto } from '@tcg-live/core';

export type LfgPanelRefresher = () => Promise<LfgPanelStatusDto[]>;

export class LfgRuntime {
  private readonly panels = new Map<string, LfgPanelStatusDto>();
  private refresher: LfgPanelRefresher | null = null;

  setPanel(status: LfgPanelStatusDto | null, channelId?: string): void {
    if (status) this.panels.set(status.channelId, status); else if (channelId) this.panels.delete(channelId);
  }
  panelStatuses(): LfgPanelStatusDto[] { return [...this.panels.values()]; }
  registerRefresher(refresher: LfgPanelRefresher | null): () => void {
    this.refresher = refresher;
    return () => { if (this.refresher === refresher) this.refresher = null; };
  }
  panelRefresher(): LfgPanelRefresher | null { return this.refresher; }
  reset(): void { this.panels.clear(); this.refresher = null; }
}

export const lfgRuntime = new LfgRuntime();
