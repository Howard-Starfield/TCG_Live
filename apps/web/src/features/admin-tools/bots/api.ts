// Helper voice bot calls for the Bots tab. Tokens are sent once (add, replace) and never come back.
import type { ReplaceVoiceBotTokenRequestDto, UpdateVoiceBotRequestDto, VoiceBotPoolDto, VoiceBotVerifyReportDto } from '@tcg-live/core';
import type { ApiClient } from '../../../data';

const base = (id: string) => `/moderation/voice-bots/${encodeURIComponent(id)}`;

export const updateVoiceBot = (api: ApiClient, id: string, body: UpdateVoiceBotRequestDto) =>
  api.request<VoiceBotPoolDto>('PATCH', base(id), { body });
export const replaceVoiceBotToken = (api: ApiClient, id: string, body: ReplaceVoiceBotTokenRequestDto) =>
  api.request<VoiceBotPoolDto>('PUT', `${base(id)}/token`, { body });
export const verifyVoiceBot = (api: ApiClient, id: string, channelIds?: string[]) =>
  api.request<VoiceBotVerifyReportDto>('POST', `${base(id)}/verify`, { body: channelIds ? { channelIds } : {} });
export const retryVoiceBot = (api: ApiClient, id: string) =>
  api.request<VoiceBotPoolDto>('POST', `${base(id)}/retry`);

export const DEVELOPER_PORTAL_URL = 'https://discord.com/developers/applications';
/** About 30 MB per player-hour of raw Opus at 64 kbps, two players per room. */
export const BYTES_PER_ROOM_HOUR = 60 * 1024 * 1024;
