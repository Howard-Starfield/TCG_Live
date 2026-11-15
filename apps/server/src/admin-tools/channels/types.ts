// Feature-local wire types for stickies (agent B). The web mirrors these in
// apps/web/src/features/admin-tools/stickies/types.ts; the frozen contract is untouched.
import type { StickyMessageDto } from '@tcg-live/core';

export type StickyRuntimeState = 'posted' | 'waiting' | 'missing-permissions' | 'channel-missing' | 'reserved' | 'failed' | 'disabled';
export interface StickyRuntimeStatus { state: StickyRuntimeState; message: string | null; atMs: number }

/** GET /api/v1/admin-tools/stickies items: the contract DTO plus the running bot's last report. */
export interface StickyListItemDto extends StickyMessageDto { status: StickyRuntimeStatus | null }
export interface StickyListDto { stickies: StickyListItemDto[] }
