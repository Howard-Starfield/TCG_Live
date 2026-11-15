// Discord REST calls made WITH A HELPER'S OWN TOKEN: identify its application, verify it in the server
// and set its per-server nickname. The token is used only in the Authorization header here; nothing a
// caller sees (results, errors) contains it or any response text.
import { PermissionFlagsBits } from 'discord.js';
import type { VoiceBotChannelCheckDto, VoiceBotErrorCode } from '@tcg-live/core';
import { channelPermissions, hasPermission, type Overwrite } from '../permissions/checker.js';

const API = 'https://discord.com/api/v10';
const TIMEOUT_MS = 10_000;

export type ProbeResult =
  | { ok: true; applicationId: string; botPublic: boolean; requireCodeGrant: boolean }
  | { ok: false; code: VoiceBotErrorCode };

export interface HelperMembership {
  ok: true;
  inServer: boolean;
  nickname: string | null;
  /** Server-wide permissions of the helper (roles only). */
  guildPermissions: bigint;
  channels: VoiceBotChannelCheckDto[];
}
export type MembershipResult = HelperMembership | { ok: false; code: VoiceBotErrorCode };

/** What the helper registry needs from Discord; tests and the demo use fakes. */
export interface HelperDiscordApi {
  probe(token: string): Promise<ProbeResult>;
  membership(token: string, guildId: string, botUserId: string, channelIds: readonly string[]): Promise<MembershipResult>;
  setNickname(token: string, guildId: string, nickname: string | null): Promise<{ ok: true } | { ok: false; code: VoiceBotErrorCode }>;
}

class RestFailure extends Error { constructor(readonly code: VoiceBotErrorCode, readonly status: number | null) { super(code); } }

function codeFor(status: number): VoiceBotErrorCode {
  if (status === 401) return 'invalid-token';
  if (status === 403) return 'missing-permissions';
  if (status === 404) return 'not-in-server';
  if (status === 429) return 'rate-limited';
  return 'unknown';
}

/** Production implementation (global fetch). */
export function discordHelperApi(fetcher: typeof fetch = fetch): HelperDiscordApi {
  const call = async <T>(token: string, method: string, route: string, body?: unknown): Promise<T> => {
    let response: Response;
    try {
      response = await fetcher(`${API}${route}`, { method, signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (tcg-live, 1)' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      throw new RestFailure(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network', null);
    }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new RestFailure(codeFor(response.status), response.status); }
    return response.status === 204 ? undefined as T : await response.json() as T;
  };
  const failed = (error: unknown) => ({ ok: false as const, code: error instanceof RestFailure ? error.code : 'unknown' as const });
  return {
    async probe(token) {
      try {
        const app = await call<{ id: string; bot_public?: boolean; bot_require_code_grant?: boolean }>(token, 'GET', '/applications/@me');
        return { ok: true, applicationId: String(app.id), botPublic: app.bot_public === true, requireCodeGrant: app.bot_require_code_grant === true };
      } catch (error) { return failed(error); }
    },
    async membership(token, guildId, botUserId, channelIds) {
      let member: { roles: string[]; nick?: string | null };
      try { member = await call(token, 'GET', `/guilds/${guildId}/members/${botUserId}`); }
      catch (error) {
        if (error instanceof RestFailure && (error.status === 404 || error.status === 403))
          return { ok: true, inServer: false, nickname: null, guildPermissions: 0n, channels: [] };
        return failed(error);
      }
      try {
        const roles = await call<Array<{ id: string; permissions: string }>>(token, 'GET', `/guilds/${guildId}/roles`);
        const bits = new Map(roles.map(role => [role.id, BigInt(role.permissions)]));
        const base = [guildId, ...member.roles].reduce((acc, id) => acc | (bits.get(id) ?? 0n), 0n);
        const channels: VoiceBotChannelCheckDto[] = [];
        for (const channelId of channelIds) {
          let channel: { permission_overwrites?: Array<{ id: string; type: number; allow: string; deny: string }> };
          try { channel = await call(token, 'GET', `/channels/${channelId}`); }
          catch (error) {
            // 403/404: the helper cannot see this channel.
            if (error instanceof RestFailure && (error.status === 403 || error.status === 404)) {
              channels.push({ channelId, viewChannel: false, connect: false, state: 'problem' });
              continue;
            }
            channels.push({ channelId, viewChannel: false, connect: false, state: 'unknown' });
            continue;
          }
          const overwrites = channel.permission_overwrites ?? [];
          const toOverwrite = (item: { allow: string; deny: string }): Overwrite => ({ allow: BigInt(item.allow), deny: BigInt(item.deny) });
          const everyone = overwrites.find(item => item.id === guildId);
          const permissions = channelPermissions({ base, ...(everyone ? { everyone: toOverwrite(everyone) } : {}),
            roles: overwrites.filter(item => item.type === 0 && item.id !== guildId && member.roles.includes(item.id)).map(toOverwrite),
            ...(() => { const own = overwrites.find(item => item.type === 1 && item.id === botUserId); return own ? { member: toOverwrite(own) } : {}; })() });
          const view = hasPermission(permissions, 'ViewChannel');
          const connect = view && hasPermission(permissions, 'Connect');
          channels.push({ channelId, viewChannel: view, connect, state: view && connect ? 'ok' : 'problem' });
        }
        return { ok: true, inServer: true, nickname: member.nick ?? null, guildPermissions: base, channels };
      } catch (error) { return failed(error); }
    },
    async setNickname(token, guildId, nickname) {
      try { await call(token, 'PATCH', `/guilds/${guildId}/members/@me`, { nick: nickname ?? '' }); return { ok: true }; }
      catch (error) { return failed(error); }
    }
  };
}

/** Server-wide grants a voice-only helper should not have. */
export function broadPermissionWarnings(bits: bigint): string[] {
  const warnings: string[] = [];
  if ((bits & PermissionFlagsBits.Administrator) !== 0n)
    warnings.push('The helper has Administrator. It only needs View Channel and Connect; remove the extra role or permission.');
  else if ((bits & PermissionFlagsBits.ManageGuild) !== 0n)
    warnings.push('The helper has Manage Server. It only needs View Channel and Connect; remove the extra role or permission.');
  return warnings;
}

/** Offline stand-in for the demo: every token "works" and every room check passes. Never touches the network. */
export function offlineHelperApi(): HelperDiscordApi {
  return {
    async probe(token) {
      const first = token.split('.')[0] ?? '';
      const userId = Buffer.from(first, 'base64url').toString('utf8');
      return { ok: true, applicationId: /^\d{15,22}$/.test(userId) ? userId : '100000000000000000', botPublic: false, requireCodeGrant: false };
    },
    async membership(_token, _guildId, _botUserId, channelIds) {
      return { ok: true, inServer: true, nickname: null, guildPermissions: PermissionFlagsBits.ViewChannel | PermissionFlagsBits.Connect,
        channels: channelIds.map(channelId => ({ channelId, viewChannel: true, connect: true, state: 'ok' as const })) };
    },
    async setNickname() { return { ok: true }; }
  };
}
