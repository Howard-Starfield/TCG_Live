// Shared moderation action body (agent G1): the dashboard route (POST /admin-tools/actions) and the
// `/tcg-admin` moderation subcommands both call moderateMember, so cases, audit rows, DMs and the case log
// behave identically. Only the actor (local admin vs. the real Discord user) and the case source differ.
import type { AdminToolsSettingsBodyDto, ModActionRequestDto, ModActionResultDto, ModCaseDto, ModCaseSource } from '@tcg-live/core';
import { HttpError } from '../../admin/http/respond.js';
import type { OpsActor } from '../../ops/audit.js';
import type { BackendAction, MembersBackend } from './backend.js';
import { assertCanModerate, discordReason, dmText } from './routes.js';
import type { ModCaseStore } from './store.js';

export interface ModerateDeps {
  guildId: string;
  now(): number;
  backend: MembersBackend;
  cases: ModCaseStore;
  settings(): Promise<Pick<AdminToolsSettingsBodyDto, 'cases'>>;
  /** Maps store errors to safe errors (the routes' `guarded`); identity when absent. */
  guarded?<T>(run: () => Promise<T>): Promise<T>;
}

const DM_ACTIONS: readonly ModActionRequestDto['action'][] = ['warn', 'timeout', 'kick', 'ban'];

function backendAction(request: ModActionRequestDto, now: number): BackendAction | null {
  switch (request.action) {
    case 'warn': return null;
    case 'timeout': return { kind: 'timeout', untilMs: now + request.durationMs };
    case 'ban': return { kind: 'ban', deleteMessageSeconds: request.deleteMessageSeconds };
    default: return { kind: request.action };
  }
}

/** When the case ends on its own: a timeout's end, or a tempban's expiry (lifted by the tempban scheduler). */
export function caseExpiry(request: ModActionRequestDto, now: number): number | null {
  if (request.action === 'timeout') return now + request.durationMs;
  if (request.action === 'ban' && request.durationMs !== null) return now + request.durationMs;
  return null;
}

/** Validates the target, opens the numbered case with the Discord action, DMs the member and posts the case log. */
export async function moderateMember(deps: ModerateDeps, request: ModActionRequestDto, actor: OpsActor,
  source: ModCaseSource): Promise<ModActionResultDto> {
  const guarded = deps.guarded ?? (<T>(run: () => Promise<T>) => run());
  const discord = deps.backend;
  const target = await discord.target(request.userId);
  assertCanModerate(request.action, target);
  if (request.action === 'warn' && !target.inGuild && !(await discord.member(request.userId)))
    throw new HttpError(404, 'not_found', 'Discord does not know that member.');
  const settings = await deps.settings();
  const wantsDm = settings.cases.dmMembers && DM_ACTIONS.includes(request.action);
  const now = deps.now();
  const action = backendAction(request, now);
  let dm: ModActionResultDto['dm'] = 'skipped';
  const sendDm = async (number: number) => { dm = await discord.dm(request.userId, dmText(request, number)).catch(() => false) ? 'sent' : 'failed'; };
  const saved: ModCaseDto = await guarded(() => deps.cases.create(deps.guildId, {
    kind: request.action, targetId: request.userId, reason: request.reason, evidenceIds: request.evidenceIds ?? [],
    eventId: request.eventId ?? null, matchId: request.matchId ?? null, source, expiresAtMs: caseExpiry(request, now)
  }, actor, async number => {
    // Kicked or banned members share no server with the bot afterwards, so they hear first.
    if (wantsDm && (request.action === 'kick' || request.action === 'ban')) await sendDm(number);
    if (action) await discord.apply(request.userId, action, discordReason(number, request.reason));
  }));
  if (wantsDm && (request.action === 'warn' || request.action === 'timeout')) await sendDm(saved.number);
  if (settings.cases.logChannelId) {
    const by = actor.id === 'local-admin' ? 'Dashboard (local admin)' : actor.id === 'bot' ? 'bot' : `<@${actor.id}>`;
    const until = saved.kind === 'ban' && saved.expiresAtMs ? ` · until <t:${Math.floor(saved.expiresAtMs / 1000)}:f>` : '';
    const line = `Case #${saved.number} · ${saved.kind}${until} · <@${saved.targetId}> · by ${by} · ${saved.reason}`.slice(0, 1900);
    await discord.postLog(settings.cases.logChannelId, line).catch(() => {});
  }
  return { case: saved, dm };
}
