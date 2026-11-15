// Admin tools (A): member search and profile, ban list, moderation actions (warn/timeout/kick/ban/unban)
// with numbered cases, case editing, private mod notes and the mod-action audit trail. Reading needs
// members.read; every change needs members.moderate and is audited in tcg_ops_audit.
import { ADMIN_TOOLS_LIMITS as L, type BanEntryDto, type BanListDto, type MemberProfileDto, type MemberSearchDto, type MemberSummaryDto,
  type ModAction, type ModActionRequestDto, type ModActionResultDto, type ModAuditEntryDto, type ModAuditPageDto, type ModCaseDto,
  type TournamentHistoryRefDto } from '@tcg-live/core';
import { readJsonBody } from '../../admin/http/body.js';
import { HttpError, sendJson } from '../../admin/http/respond.js';
import { LOCAL_ADMIN } from '../../ops/audit.js';
import { badRequest, integerQuery, onlyParams, SNOWFLAKE, type OpsRoute } from '../../ops/http.js';
import type { AdminToolsRouteDeps, AdminToolsRouteModule } from '../module.js';
import { demoMembersBackend, liveMembersBackend, type BackendAction, type DemoMembersBackendOptions, type ExternalAuditState,
  type MemberRecord, type MembersBackend, type TargetInfo } from './backend.js';
import { parseCaseKind, parseCasePatch, parseDeleteCase, parseModAction, parseNoteBody, parseSearchQuery } from './parse.js';
import { MemoryModCaseStore, MemoryModNoteStore, pgModCaseStore, pgModNoteStore, type ModCaseStore, type ModNoteStore } from './store.js';

const DAY = 86_400_000;
/** Newest events scanned for a member's tournament history (one snapshot each). */
export const HISTORY_EVENT_SCAN = 25;
const CASE_PAGE_MAX = 100;
const BAN_PAGE_MAX = 1000;

/** Feature-only wire extension of ModAuditPageDto: whether the Discord audit log could be read. */
export interface ModAuditPageWithStateDto extends ModAuditPageDto { discordAudit: ExternalAuditState }

export interface MembersModuleOptions {
  /** Overrides the Discord access (tests). Default: the demo guild, else live Discord. */
  backend?(deps: AdminToolsRouteDeps): MembersBackend;
  cases?(deps: AdminToolsRouteDeps): ModCaseStore;
  notes?(deps: AdminToolsRouteDeps): ModNoteStore;
  demo?: DemoMembersBackendOptions;
}

const refuse = (message: string) => new HttpError(422, 'rule', message);
const PERMISSION: Record<Exclude<ModAction, 'warn'>, { key: keyof TargetInfo['bot']; label: string }> = {
  timeout: { key: 'moderate', label: 'Timeout Members' }, untimeout: { key: 'moderate', label: 'Timeout Members' },
  kick: { key: 'kick', label: 'Kick Members' }, ban: { key: 'ban', label: 'Ban Members' }, unban: { key: 'ban', label: 'Ban Members' }
};

/**
 * Throws a clear HttpError when the bot may not do `action` to this target: never itself or the owner,
 * the needed permission, the target in the server where it must be, and the bot's highest role strictly
 * above the target's (Discord's role hierarchy).
 */
export function assertCanModerate(action: ModAction, target: TargetInfo): void {
  if (target.isBotSelf) throw refuse('The bot cannot moderate itself.');
  if (target.isOwner) throw refuse('Nobody can moderate the server owner.');
  if (action !== 'warn') {
    const need = PERMISSION[action];
    if (!target.bot[need.key]) throw refuse(`The bot needs the ${need.label} permission. Give its role that permission in Server Settings > Roles.`);
  }
  if (['timeout', 'untimeout', 'kick'].includes(action) && !target.inGuild) throw new HttpError(404, 'not_found', 'That member is not in the server.');
  if (action === 'ban' && target.banned) throw new HttpError(409, 'conflict', 'That user is already banned.');
  if (action === 'unban' && !target.banned) throw new HttpError(404, 'not_found', 'That user is not banned.');
  if (action === 'untimeout' && target.timedOutUntilMs === null) throw new HttpError(409, 'conflict', 'That member is not timed out.');
  if (action !== 'unban' && action !== 'warn' && target.inGuild && target.targetTop !== null && target.targetTop >= target.botTop)
    throw refuse("The bot's highest role must be above this member's highest role. Move the bot's role up in Server Settings > Roles.");
}

const VERB: Record<ModAction, string> = { warn: 'warned', timeout: 'timed out', untimeout: 'no longer timed out', kick: 'kicked',
  ban: 'banned', unban: 'unbanned' };
const DM_ACTIONS: readonly ModAction[] = ['warn', 'timeout', 'kick', 'ban'];

export function dmText(request: ModActionRequestDto, number: number): string {
  const until = request.action === 'timeout' ? ` until ${new Date(Date.now() + request.durationMs).toUTCString()}` : '';
  return `You were ${VERB[request.action]}${until} by the server staff (case #${number}).\nReason: ${request.reason}`.slice(0, 1900);
}
/** Discord's audit-log reason (512). */
export function discordReason(number: number, reason: string): string {
  return `Case #${number}: ${reason}`.slice(0, L.discordReasonLength);
}

function backendAction(request: ModActionRequestDto, now: number): BackendAction | null {
  switch (request.action) {
    case 'warn': return null;
    case 'timeout': return { kind: 'timeout', untilMs: now + request.durationMs };
    case 'ban': return { kind: 'ban', deleteMessageSeconds: request.deleteMessageSeconds };
    default: return { kind: request.action };
  }
}

function historyRole(snapshot: { adminId: string; seats: Record<string, string | null>; signup: { roster: string[] } | null }, id: string) {
  if (Object.values(snapshot.seats).includes(id)) return 'player' as const;
  if (snapshot.signup?.roster.includes(id)) return 'roster' as const;
  if (snapshot.adminId === id) return 'admin' as const;
  return null;
}

export function membersRouteModule(options: MembersModuleOptions = {}): AdminToolsRouteModule {
  return { name: 'members', routes: deps => membersRoutes(deps, options) };
}

function membersRoutes(deps: AdminToolsRouteDeps, options: MembersModuleOptions): OpsRoute[] {
  const memory = deps.storage === 'memory';
  const cases = options.cases?.(deps) ?? (memory ? new MemoryModCaseStore(deps.audit, deps.now) : pgModCaseStore(deps.now));
  const notes = options.notes?.(deps) ?? (memory ? new MemoryModNoteStore(deps.audit, deps.now) : pgModNoteStore(deps.now));
  let cached: MembersBackend | null = null;
  const backend = (): MembersBackend => {
    if (cached) return cached;
    if (options.backend) cached = options.backend(deps);
    else if (deps.demo) cached = demoMembersBackend(deps.demo, { now: deps.now, ...options.demo });
    else if (deps.discord) cached = liveMembersBackend(deps.discord);
    else throw new HttpError(503, 'unavailable', 'Discord is not connected.');
    return cached;
  };
  const { guarded } = deps;
  const userParam = (raw: string | undefined) => {
    if (!raw || !SNOWFLAKE.test(raw)) throw badRequest('Member must be a Discord ID.');
    return raw;
  };
  const numberParam = (raw: string | undefined) => {
    const value = Number(raw);
    if (!raw || !/^\d{1,9}$/.test(raw) || !Number.isSafeInteger(value) || value < 1) throw badRequest('Case number must be a positive integer.');
    return value;
  };

  async function summaries(records: MemberRecord[]): Promise<MemberSummaryDto[]> {
    const guildId = deps.guildId();
    const ids = records.map(record => record.id);
    const [caseCounts, noteCounts, settings] = await Promise.all([guarded(() => cases.counts(guildId, ids)),
      guarded(() => notes.counts(guildId, ids)), deps.currentSettings()]);
    const days = settings.logging.joinLeave.newAccountDays;
    return records.map(record => ({
      id: record.id, username: record.username, displayName: record.displayName, avatarUrl: record.avatarUrl, roleIds: record.roleIds,
      joinedAtMs: record.joinedAtMs, accountCreatedAtMs: record.accountCreatedAtMs,
      flags: { banned: false, timedOutUntilMs: record.timedOutUntilMs, bot: record.bot, left: !record.inGuild,
        newAccount: days > 0 && record.accountCreatedAtMs > deps.now() - days * DAY },
      caseCount: caseCounts.get(record.id) ?? 0, noteCount: noteCounts.get(record.id) ?? 0
    }));
  }

  async function tournaments(id: string): Promise<TournamentHistoryRefDto[]> {
    if (!deps.listEvents || !deps.snapshot) return [];
    const events = (await deps.listEvents()).slice(0, HISTORY_EVENT_SCAN);
    const refs = await Promise.all(events.map(async event => {
      const snapshot = await deps.snapshot!(event.eventId);
      const role = snapshot ? historyRole(snapshot, id) : null;
      const ref: TournamentHistoryRefDto | null = role ? { eventId: event.eventId, name: null, status: event.status, createdAtMs: event.createdAtMs, role } : null;
      return ref;
    }));
    return refs.filter((ref): ref is TournamentHistoryRefDto => ref !== null);
  }

  async function profile(id: string): Promise<MemberProfileDto> {
    const guildId = deps.guildId();
    const [record, ban, caseList, noteList, history] = await Promise.all([backend().member(id), backend().ban(id),
      guarded(() => cases.list(guildId, { targetId: id, limit: CASE_PAGE_MAX })), guarded(() => notes.list(guildId, id)), tournaments(id)]);
    if (!record && !caseList.cases.length && !noteList.length) throw new HttpError(404, 'not_found', 'Discord does not know that member.');
    const base: MemberRecord = record ?? { id, username: ban?.username ?? id, displayName: null, avatarUrl: ban?.avatarUrl ?? null, roleIds: [],
      joinedAtMs: null, accountCreatedAtMs: Number((BigInt(id) >> 22n) + 1_420_070_400_000n), bot: false, timedOutUntilMs: null, inGuild: false };
    const [summary] = await summaries([base]);
    return { ...summary!, flags: { ...summary!.flags, banned: ban !== null }, cases: caseList.cases, notes: noteList, tournaments: history };
  }

  async function act(request: ModActionRequestDto): Promise<ModActionResultDto> {
    const guildId = deps.guildId();
    const discord = backend();
    const target = await discord.target(request.userId);
    assertCanModerate(request.action, target);
    if (request.action === 'warn' && !target.inGuild && !(await discord.member(request.userId)))
      throw new HttpError(404, 'not_found', 'Discord does not know that member.');
    const settings = await deps.currentSettings();
    const wantsDm = settings.cases.dmMembers && DM_ACTIONS.includes(request.action);
    const now = deps.now();
    const action = backendAction(request, now);
    let dm: ModActionResultDto['dm'] = 'skipped';
    const sendDm = async (number: number) => { dm = await discord.dm(request.userId, dmText(request, number)).catch(() => false) ? 'sent' : 'failed'; };
    const saved = await guarded(() => cases.create(guildId, {
      kind: request.action, targetId: request.userId, reason: request.reason, evidenceIds: request.evidenceIds ?? [],
      eventId: request.eventId ?? null, matchId: request.matchId ?? null, source: 'dashboard',
      expiresAtMs: request.action === 'timeout' ? now + request.durationMs : null
    }, LOCAL_ADMIN, async number => {
      // Kicked or banned members share no server with the bot afterwards, so they hear first.
      if (wantsDm && (request.action === 'kick' || request.action === 'ban')) await sendDm(number);
      if (action) await discord.apply(request.userId, action, discordReason(number, request.reason));
    }));
    if (wantsDm && (request.action === 'warn' || request.action === 'timeout')) await sendDm(saved.number);
    if (settings.cases.logChannelId) {
      const line = `Case #${saved.number} · ${saved.kind} · <@${saved.targetId}> · ${saved.reason}`.slice(0, 1900);
      await discord.postLog(settings.cases.logChannelId, line).catch(() => {});
    }
    deps.notify('members', String(saved.number));
    return { case: saved, dm };
  }

  async function bans(query: URLSearchParams): Promise<BanListDto> {
    onlyParams(query, ['q', 'after', 'limit']);
    const after = query.get('after');
    if (after !== null && !SNOWFLAKE.test(after)) throw badRequest('after must be a Discord ID.');
    const limit = integerQuery(query, 'limit', BAN_PAGE_MAX, 1, BAN_PAGE_MAX);
    const q = query.get('q')?.trim().toLowerCase() ?? '';
    const page = await backend().bans(after, limit);
    const linked = await guarded(() => cases.latestBans(deps.guildId(), page.map(ban => ban.userId)));
    const entries: BanEntryDto[] = page.map(ban => ({ userId: ban.userId, username: ban.username, avatarUrl: ban.avatarUrl, reason: ban.reason,
      caseNumber: linked.get(ban.userId)?.number ?? null, expiresAtMs: null }));
    return { bans: q ? entries.filter(ban => ban.username.toLowerCase().includes(q) || ban.userId.startsWith(q) || (ban.reason ?? '').toLowerCase().includes(q))
      : entries, nextAfter: page.length === limit ? page.at(-1)!.userId : null };
  }

  async function modAudit(query: URLSearchParams): Promise<ModAuditPageWithStateDto> {
    onlyParams(query, ['before', 'limit']);
    const before = integerQuery(query, 'before', deps.now() + 1, 1, Number.MAX_SAFE_INTEGER);
    const limit = integerQuery(query, 'limit', 50, 1, CASE_PAGE_MAX);
    const [ours, external] = await Promise.all([guarded(() => cases.list(deps.guildId(), { createdBeforeMs: before, limit })),
      backend().externalAudit(before, limit).catch(() => ({ entries: [], state: 'unavailable' as const }))]);
    const fromCase = (item: ModCaseDto): ModAuditEntryDto => ({ id: `case:${item.number}`, kind: item.kind, targetId: item.targetId,
      moderatorId: item.moderatorId, reason: item.reason, caseNumber: item.number, source: item.source, occurredAtMs: item.createdAtMs });
    const merged = [...ours.cases.map(fromCase), ...external.entries.map(entry => ({ id: `discord:${entry.id}`, kind: entry.kind,
      targetId: entry.targetId, moderatorId: entry.moderatorId, reason: entry.reason, caseNumber: null, source: 'external' as const,
      occurredAtMs: entry.occurredAtMs }))].sort((a, b) => b.occurredAtMs - a.occurredAtMs);
    const entries = merged.slice(0, limit);
    const more = merged.length > limit || ours.nextBefore !== null || external.entries.length >= limit;
    return { entries, nextBefore: more && entries.length ? entries.at(-1)!.occurredAtMs : null, discordAudit: external.state };
  }

  return [
    { pattern: /^\/api\/v1\/admin-tools\/members$/, methods: {
      GET: { access: 'members.read', run: async ({ response, query }) => {
        onlyParams(query, ['q', 'limit']);
        const q = await guarded(async () => parseSearchQuery(query.get('q')));
        const limit = integerQuery(query, 'limit', L.memberSearchLimit, 1, L.memberSearchLimit);
        let records: MemberRecord[];
        if (SNOWFLAKE.test(q)) { const one = await backend().member(q); records = one ? [one] : []; }
        else records = await backend().search(q, limit + 1);
        const body: MemberSearchDto = { members: await summaries(records.slice(0, limit)), truncated: records.length > limit };
        sendJson(response, 200, body);
      } }
    } },
    { pattern: /^\/api\/v1\/admin-tools\/members\/([^/]+)$/, methods: {
      GET: { access: 'members.read', run: async ({ response, params }) => { sendJson(response, 200, await profile(userParam(params[0]))); } }
    } },
    { pattern: /^\/api\/v1\/admin-tools\/bans$/, methods: {
      GET: { access: 'members.read', run: async ({ response, query }) => { sendJson(response, 200, await bans(query)); } }
    } },
    { pattern: /^\/api\/v1\/admin-tools\/actions$/, methods: {
      POST: { access: 'members.moderate', run: async ({ request, response }) => {
        const parsed = await guarded(async () => parseModAction(await readJsonBody(request)));
        sendJson(response, 200, await act(parsed));
      } }
    } },
    { pattern: /^\/api\/v1\/admin-tools\/cases$/, methods: {
      GET: { access: 'members.read', run: async ({ response, query }) => {
        onlyParams(query, ['targetId', 'kind', 'moderatorId', 'before', 'limit']);
        const targetId = query.get('targetId');
        if (targetId !== null && !SNOWFLAKE.test(targetId)) throw badRequest('targetId must be a Discord ID.');
        const moderatorId = query.get('moderatorId');
        if (moderatorId !== null && !/^([1-9]\d{14,21}|local-admin|bot)$/.test(moderatorId)) throw badRequest('Unknown moderator.');
        const kind = await guarded(async () => parseCaseKind(query.get('kind')));
        const before = query.get('before') === null ? null : integerQuery(query, 'before', 1, 1, 2 ** 31 - 1);
        const limit = integerQuery(query, 'limit', 50, 1, CASE_PAGE_MAX);
        sendJson(response, 200, await guarded(() => cases.list(deps.guildId(), { targetId, kind, moderatorId, before, limit })));
      } }
    } },
    { pattern: /^\/api\/v1\/admin-tools\/cases\/([^/]+)$/, methods: {
      GET: { access: 'members.read', run: async ({ response, params }) => {
        const number = numberParam(params[0]);
        sendJson(response, 200, await guarded(() => cases.get(deps.guildId(), number)));
      } },
      PUT: { access: 'members.moderate', run: async ({ request, response, params }) => {
        const number = numberParam(params[0]);
        const patch = await guarded(async () => parseCasePatch(await readJsonBody(request)));
        const saved = await guarded(() => cases.update(deps.guildId(), number, patch, LOCAL_ADMIN));
        deps.notify('members', String(number));
        sendJson(response, 200, saved);
      } },
      DELETE: { access: 'members.moderate', run: async ({ request, response, params }) => {
        const number = numberParam(params[0]);
        const reason = await guarded(async () => parseDeleteCase(await readJsonBody(request)));
        await guarded(() => cases.remove(deps.guildId(), number, reason, LOCAL_ADMIN));
        deps.notify('members', String(number));
        sendJson(response, 200, { deleted: number });
      } }
    } },
    { pattern: /^\/api\/v1\/admin-tools\/notes$/, methods: {
      GET: { access: 'members.read', run: async ({ response, query }) => {
        onlyParams(query, ['targetId']);
        const targetId = userParam(query.get('targetId') ?? undefined);
        sendJson(response, 200, { notes: await guarded(() => notes.list(deps.guildId(), targetId)) });
      } },
      POST: { access: 'members.moderate', run: async ({ request, response }) => {
        const input = await guarded(async () => {
          const body = await readJsonBody(request);
          const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
          if (Object.keys(record).some(key => key !== 'targetId' && key !== 'body')) throw badRequest('Note has unknown fields.');
          return { targetId: userParam(typeof record.targetId === 'string' ? record.targetId : undefined), body: parseNoteBody(record.body) };
        });
        const note = await guarded(() => notes.add(deps.guildId(), input.targetId, input.body, LOCAL_ADMIN));
        deps.notify('members', input.targetId);
        sendJson(response, 201, note);
      } }
    } },
    { pattern: /^\/api\/v1\/admin-tools\/notes\/(\d{1,15})$/, methods: {
      PUT: { access: 'members.moderate', run: async ({ request, response, params }) => {
        const body = await guarded(async () => {
          const input = await readJsonBody(request);
          const record = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
          if (Object.keys(record).some(key => key !== 'body')) throw badRequest('Note has unknown fields.');
          return parseNoteBody(record.body);
        });
        sendJson(response, 200, await guarded(() => notes.update(deps.guildId(), Number(params[0]), body, LOCAL_ADMIN)));
      } },
      DELETE: { access: 'members.moderate', run: async ({ response, params }) => {
        await guarded(() => notes.remove(deps.guildId(), Number(params[0]), LOCAL_ADMIN));
        sendJson(response, 200, { deleted: Number(params[0]) });
      } }
    } },
    { pattern: /^\/api\/v1\/admin-tools\/mod-audit$/, methods: {
      GET: { access: 'members.read', run: async ({ response, query }) => { sendJson(response, 200, await modAudit(query)); } }
    } }
  ];
}

export const membersModule = membersRouteModule();
