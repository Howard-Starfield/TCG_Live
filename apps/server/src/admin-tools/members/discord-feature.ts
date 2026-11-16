// Members in Discord (agent G1): the `/tcg-admin` moderation subcommands (warn, timeout, untimeout, kick,
// ban [duration = tempban], unban, case, note) and the tempban expiry scheduler. Actions go through the
// same service as the dashboard (service.ts), so cases, audit rows, DMs and the case log are identical;
// the actor is the real Discord user and the case source is 'discord'. Replies are ephemeral.
import { MessageFlags, PermissionFlagsBits, type ChatInputCommandInteraction } from 'discord.js';
import { staffMay, type ModAction, type ModCaseDto } from '@tcg-live/core';
import type { DiscordFeature, DiscordFeatureContext } from '../../discord/features.js';
import { judgeDenied, memberRoleIds, STAFF_DENIED } from '../../discord/staff.js';
import { HttpError } from '../../admin/http/respond.js';
import type { OpsActor } from '../../ops/audit.js';
import { RuleError } from '../../rehearsal/domain.js';
import { liveMembersBackend, type MembersBackend, type TargetInfo } from './backend.js';
import { parseModAction, parseNoteBody } from './parse.js';
import { moderateMember } from './service.js';
import { pgModCaseStore, pgModNoteStore, type ModCaseStore, type ModNoteStore } from './store.js';
import { liftExpiredTempbans, TEMPBAN_CHECK_MS } from './tempbans.js';

const SNOWFLAKE = /^[1-9]\d{14,21}$/;
const UNITS: Record<string, number> = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };

/** "30m", "2h", "1d12h", "1w". Null when the text is not a duration. */
export function parseDuration(raw: string | null | undefined): number | null {
  const text = (raw ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!text || !/^(\d{1,4}(m|min|h|d|w))+$/.test(text)) return null;
  let total = 0;
  for (const part of text.matchAll(/(\d{1,4})(min|m|h|d|w)/g)) total += Number(part[1]) * UNITS[part[2]!]!;
  return total > 0 ? total : null;
}

export function formatDuration(ms: number): string {
  const parts: string[] = [];
  for (const [unit, size] of [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000]] as const) {
    const count = Math.floor(ms / size);
    if (count) { parts.push(`${count}${unit}`); ms -= count * size; }
  }
  return parts.join(' ') || '0m';
}

/** Discord permission that also allows each subcommand (besides the organizer and staff roles). */
const PERMISSION: Record<string, bigint> = {
  warn: PermissionFlagsBits.ModerateMembers, timeout: PermissionFlagsBits.ModerateMembers, untimeout: PermissionFlagsBits.ModerateMembers,
  kick: PermissionFlagsBits.KickMembers, ban: PermissionFlagsBits.BanMembers, unban: PermissionFlagsBits.BanMembers,
  case: PermissionFlagsBits.ModerateMembers, note: PermissionFlagsBits.ModerateMembers
};

export interface MembersDiscordOptions {
  backend?(ctx: DiscordFeatureContext): MembersBackend;
  cases?(): ModCaseStore;
  notes?(): ModNoteStore;
  now?(): number;
  checkEveryMs?: number;
}

/**
 * Discord's own rule for moderators: only members whose highest role is below the moderator's. The server
 * owner is exempt (the organizer is exempted by the caller). Unban has no target member. Null = allowed.
 */
export function actorOutranks(actor: Pick<TargetInfo, 'isOwner' | 'targetTop'>, target: Pick<TargetInfo, 'inGuild' | 'isOwner' | 'targetTop'>): string | null {
  if (actor.isOwner) return null;
  if (target.isOwner) return 'Nobody can moderate the server owner.';
  if (!target.inGuild || target.targetTop === null) return null;
  if (actor.targetTop === null || target.targetTop >= actor.targetTop)
    return 'You can only moderate members whose highest role is below yours.';
  return null;
}

export const SEATED_CONFLICT = 'You and this member are both playing in the current round, so you cannot moderate them. Please ask another staff member.';

/** Conflict of interest: the actor and the target are both seated in the current round (null rooms = no active event). */
export function seatedConflict(rooms: ReadonlyArray<{ playerIds: readonly string[] }>, actorId: string, targetId: string): boolean {
  const seated = (id: string) => rooms.some(room => room.playerIds.includes(id));
  return actorId !== targetId && seated(actorId) && seated(targetId);
}

/** HttpError and RuleError (OpsInputError, OpsNotFoundError...) messages are safe to show; nothing else is. */
function safeMessage(error: unknown): string {
  if (error instanceof HttpError || error instanceof RuleError) return error.message;
  return 'That did not work. Try again in a moment.';
}

const DONE: Record<ModAction, string> = { warn: 'warned', timeout: 'timed out', untimeout: 'no longer timed out', kick: 'kicked',
  ban: 'banned', unban: 'unbanned' };

export function describeCase(item: ModCaseDto): string {
  const by = item.moderatorId === 'local-admin' ? 'Dashboard (local admin)' : item.moderatorId === 'bot' ? 'the bot' : `<@${item.moderatorId}>`;
  const lines = [`**Case #${item.number}** · ${item.kind} · <@${item.targetId}>`, `By ${by} · <t:${Math.floor(item.createdAtMs / 1000)}:f>`,
    `Reason: ${item.reason}`];
  if (item.expiresAtMs) lines.push(`${item.kind === 'ban' ? 'Tempban ends' : 'Ends'} <t:${Math.floor(item.expiresAtMs / 1000)}:R>` +
    (item.expiryHandledAtMs ? ' (lifted)' : ''));
  if (item.matchId) lines.push(`Match ${item.matchId}`);
  return lines.join('\n').slice(0, 1900);
}

export function membersDiscordFeature(options: MembersDiscordOptions = {}): DiscordFeature {
  const stops: Array<() => void> = [];
  let timer: NodeJS.Timeout | undefined;
  return {
    name: 'members',
    start(ctx) {
      const now = options.now ?? Date.now;
      const backend = options.backend?.(ctx) ?? liveMembersBackend({ guild: () => ctx.guild(), botUserId: () => ctx.client.user?.id ?? null });
      const cases = options.cases?.() ?? pgModCaseStore(now);
      const notes = options.notes?.() ?? pgModNoteStore(now);

      // Moderation is for a TCG Organizer (the server owner counts as one), or a holder of the matching Discord permission.
      // A TCG Judge, and a legacy staff role, which counts as judge, may not moderate.
      const refusal = async (interaction: ChatInputCommandInteraction, sub: string): Promise<string | null> => {
        const permission = PERMISSION[sub];
        if (permission !== undefined && interaction.memberPermissions?.has(permission)) return null;
        const staff = await ctx.staffRoleOf({ userId: interaction.user.id, roleIds: memberRoleIds(interaction.member),
          ownerId: interaction.guild?.ownerId ?? null });
        if (!staff) return STAFF_DENIED;
        return staffMay(staff.role, 'moderation') ? null : judgeDenied('moderation');
      };

      /**
       * Checks for every actor: no member at or above the actor's highest role (`hierarchy`; the server owner is
       * exempt from this one only), and no member seated in the current round when the actor is seated too.
       */
      const staffRefusal = async (actorId: string, targetId: string, hierarchy: boolean): Promise<string | null> => {
        if (hierarchy) {
          const refused = actorOutranks(await backend.target(actorId), await backend.target(targetId));
          if (refused) return refused;
        }
        const rooms = await ctx.activeMatchRooms().catch(() => []);
        return seatedConflict(rooms, actorId, targetId) ? SEATED_CONFLICT : null;
      };

      const handle = (sub: string, run: (interaction: ChatInputCommandInteraction, actor: OpsActor) => Promise<string>) =>
        ctx.interactions.onSubcommand(sub, async interaction => {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          let content: string;
          try {
            const refused = await refusal(interaction, sub);
            content = refused ?? await run(interaction, { kind: 'admin', id: interaction.user.id });
          } catch (error) { content = safeMessage(error); }
          await interaction.editReply({ content, allowedMentions: { parse: [] } });
        });

      const act = (action: ModAction) => async (interaction: ChatInputCommandInteraction, actor: OpsActor) => {
        const userId = action === 'unban' ? (interaction.options.getString('user-id', true).replace(/[<@!>]/g, '').trim())
          : interaction.options.getUser('member', true).id;
        if (!SNOWFLAKE.test(userId)) return 'Give a Discord user ID (for example 123456789012345678).';
        if (userId === interaction.user.id) return 'You cannot moderate yourself.';
        if (userId === ctx.adminId && action !== 'unban') return 'The tournament organizer cannot be moderated from Discord.';
        const refused = await staffRefusal(interaction.user.id, userId, action !== 'unban');
        if (refused) return refused;
        const body: Record<string, unknown> = { action, userId, reason: interaction.options.getString('reason', true) };
        let durationMs: number | null = null;
        if (action === 'timeout' || action === 'ban') {
          const raw = interaction.options.getString('duration');
          durationMs = parseDuration(raw);
          if (raw && durationMs === null) return 'Give the duration like 30m, 2h, 1d or 1w.';
          if (action === 'timeout' && durationMs === null) return 'Give a timeout duration like 30m, 2h or 1d.';
          body.durationMs = durationMs;
          if (action === 'ban') body.deleteMessageSeconds = interaction.options.getInteger('delete-messages') ?? 0;
        }
        const request = parseModAction(body);
        const { case: saved, dm } = await moderateMember({ guildId: ctx.guildId, now, backend, cases,
          settings: async () => ctx.adminToolsSettings() }, request, actor, 'discord');
        const length = durationMs ? ` for ${formatDuration(durationMs)}` : '';
        return `Case #${saved.number}: <@${saved.targetId}> ${action === 'ban' && durationMs ? 'temporarily banned' : DONE[action]}${length}.` +
          (dm === 'sent' ? ' They were told by DM.' : dm === 'failed' ? ' Their DMs are closed, so they were not told.' : '');
      };

      for (const action of ['warn', 'timeout', 'untimeout', 'kick', 'ban', 'unban'] as const) stops.push(handle(action, act(action)));
      stops.push(handle('case', async interaction => describeCase(await cases.get(ctx.guildId, interaction.options.getInteger('number', true)))));
      stops.push(handle('note', async (interaction, actor) => {
        const target = interaction.options.getUser('member', true).id;
        const refused = await staffRefusal(interaction.user.id, target, true);
        if (refused) return refused;
        const note = await notes.add(ctx.guildId, target, parseNoteBody(interaction.options.getString('text', true)), actor);
        return `Note #${note.id} added to <@${target}>. Only staff can see it (dashboard: Admin tools > Members).`;
      }));

      let running = false;
      const sweep = async () => {
        if (running || !ctx.isActive()) return;
        running = true;
        try {
          await liftExpiredTempbans({ guildId: ctx.guildId, now, backend, cases, log: message => ctx.log(message),
            audit: payload => ctx.audit('member.tempban_expired', payload) });
        } catch { /* Schema missing or database down: retried on the next pass. */ }
        finally { running = false; }
      };
      void sweep();
      timer = setInterval(() => { void sweep(); }, options.checkEveryMs ?? TEMPBAN_CHECK_MS);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      for (const stop of stops.splice(0)) stop();
    }
  };
}
