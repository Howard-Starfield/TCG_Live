// Mirrors apps/server/src/admin-tools/channels/types.ts (feature-local wire types, not in the frozen contract).
import type { StickyMessageDto } from '@tcg-live/core';

export type StickyRuntimeState = 'posted' | 'waiting' | 'missing-permissions' | 'channel-missing' | 'reserved' | 'failed' | 'disabled';
export interface StickyRuntimeStatus { state: StickyRuntimeState; message: string | null; atMs: number }
export interface StickyListItemDto extends StickyMessageDto { status: StickyRuntimeStatus | null }
export interface StickyListDto { stickies: StickyListItemDto[] }
