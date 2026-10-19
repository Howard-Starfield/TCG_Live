import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyDiscordCommand, setupPrivateDiscordSchema, withClient } from '../rehearsal/store.js';
import type { PrivateDiscordConfig } from './config.js';
import { acquireAdvisoryLease, bindCard, claimResumeReminder, completeStickyCard, getSessionState, prepareSession, prepareSignupSession,
  replaceStickyCard, suspendStickyCard } from './session.js';

const ids = ['111111111111111111', '222222222222222222', '333333333333333333', '444444444444444444',
  '555555555555555555', '666666666666666666', '777777777777777777', '888888888888888888',
  '999999999999999999'];
const config: PrivateDiscordConfig = { applicationId: ids[0]!, guildId: ids[1]!, channelId: ids[2]!,
  players: { A: ids[3]!, B: ids[4]!, C: ids[5]!, D: ids[6]! }, adminId: ids[7]! };
const changed: PrivateDiscordConfig = { ...config, guildId: ids[8]! };
const optIn = process.env.npm_lifecycle_event === 'test:db';

test('real database: additive migration, global lease, canonical interaction and principal audit',
  { skip: optIn ? false : 'Real database suite is opt-in: npm run test:db' }, async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the opt-in database suite.');
    const before = await withClient(async client => {
      const events = await client.query('SELECT id,version,state FROM public.tcg_rehearsal_events ORDER BY id');
      const audit = await client.query('SELECT event_id,sequence,command_id,actor_id,action,outcome FROM public.tcg_rehearsal_audit ORDER BY event_id,sequence');
      return { events: events.rows, audit: audit.rows };
    });
    assert.ok(['upgraded', 'already_ready'].includes(await setupPrivateDiscordSchema()));
    const after = await withClient(async client => {
      const events = await client.query('SELECT id,version,state FROM public.tcg_rehearsal_events ORDER BY id');
      const audit = await client.query('SELECT event_id,sequence,command_id,actor_id,action,outcome FROM public.tcg_rehearsal_audit ORDER BY event_id,sequence');
      return { events: events.rows, audit: audit.rows };
    });
    assert.deepEqual(after, before, 'migration must preserve prior fixture aggregates and audit content');

    const active = await withClient(client => client.query<{ application_id: string; guild_id: string; channel_id: string }>(
      "SELECT application_id,guild_id,channel_id FROM public.tcg_rehearsal_sessions WHERE status='active'"));
    if (active.rows[0] && (active.rows[0].application_id !== config.applicationId ||
        ![config.guildId, changed.guildId].includes(active.rows[0].guild_id) ||
        active.rows[0].channel_id !== config.channelId)) {
      throw new Error('Refusing to replace an active non-test Discord session.');
    }

    const lease = await acquireAdvisoryLease(config);
    try {
      await assert.rejects(acquireAdvisoryLease(changed), /already owned/);
      await assert.rejects(prepareSession(changed, true), /already owned/);
    } finally { await lease.release(); }

    let lostCalls = 0;
    const killedLease = await acquireAdvisoryLease(config, () => { lostCalls++; });
    try {
      const locks = await withClient(client => client.query<{ pid: number }>(
        `SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted
           AND classid=hashtext('tcg_live_private')::oid
           AND objid=hashtext('single-active-session')::oid AND objsubid=2`
      ));
      assert.equal(locks.rows.length, 1, 'terminate only the test-owned private-session lease backend');
      const terminated = await withClient(client => client.query<{ ended: boolean }>(
        'SELECT pg_terminate_backend($1) AS ended', [locks.rows[0]!.pid]));
      assert.equal(terminated.rows[0]?.ended, true);
      const deadline = Date.now() + 2_000;
      while (!killedLease.isLost() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(killedLease.isLost(), true);
      assert.equal(lostCalls, 1);
      const recovered = await acquireAdvisoryLease(changed);
      await recovered.release();
    } finally { await killedLease.release(); }

    const session = await prepareSession(changed, true);
    const selected = await getSessionState(changed);
    assert.equal(selected.session.event_id, session.event_id);
    assert.equal(selected.session.guild_id, changed.guildId);
    await bindCard(changed, session.event_id, 'checkin', ids[0]!);
    const context = { config: changed, eventId: session.event_id, principalId: changed.players.A,
      interactionId: ids[1]!, message: { slot: 'checkin' as const, id: ids[0]!, channelId: changed.channelId } };
    const outcome = await applyDiscordCommand(context, { type: 'checkin' }, 'db-discord-runner', () => 1_000);
    assert.equal(outcome.applied, true);
    assert.deepEqual(await applyDiscordCommand(context, { type: 'checkin' }, 'db-discord-runner', () => 1_001), outcome);
    await assert.rejects(applyDiscordCommand({ ...context, interactionId: ids[2]!,
      message: { slot: 'checkin', id: ids[3]!, channelId: changed.channelId } }, { type: 'checkin' }, 'db-discord-runner', () => 1_002), /canonical/);
    await assert.rejects(applyDiscordCommand({ ...context, interactionId: '131010101010101010',
      message: { slot: 'checkin', id: ids[0]!, channelId: ids[8]! } },
    { type: 'checkin' }, 'db-discord-runner', () => 1_002), /wrong practice channel/);
    await assert.rejects(applyDiscordCommand({ ...context, interactionId: '141010101010101010',
      config: { ...changed, matchChannels: { M1: ids[8]!, M2: ids[7]! } } },
    { type: 'checkin' }, 'db-discord-runner', () => 1_002), /configuration differs/);
    await assert.rejects(applyDiscordCommand({ ...context, interactionId: ids[3]!, principalId: ids[8]! },
      { type: 'checkin' }, 'db-discord-runner', () => 1_003), /not in the private fixture/);
    const audit = await withClient(client => client.query<{ principal_kind: string; principal_id: string; interaction_id: string }>(
      'SELECT principal_kind,principal_id,interaction_id FROM public.tcg_rehearsal_audit WHERE event_id=$1', [session.event_id]));
    assert.deepEqual(audit.rows, [{ principal_kind: 'discord', principal_id: changed.players.A, interaction_id: ids[1] }]);

    // A waiting command must obtain its timestamp only after the aggregate row lock.
    let clockCalls = 0;
    const locked = await withClient(async client => {
      await client.query('BEGIN');
      try {
        await client.query('SELECT id FROM public.tcg_rehearsal_events WHERE id=$1 FOR UPDATE', [session.event_id]);
        const pending = applyDiscordCommand({ ...context, principalId: changed.players.B, interactionId: ids[4]! },
          { type: 'checkin' }, 'db-discord-runner', () => { clockCalls++; return 2_000; });
        await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(clockCalls, 0);
        await client.query('COMMIT');
        return pending;
      } finally { await client.query('ROLLBACK').catch(() => {}); }
    });
    assert.equal(locked.applied, true);
    assert.equal(clockCalls, 1);

    await bindCard(changed, session.event_id, 'M1', ids[2]!);
    await bindCard(changed, session.event_id, 'M2', ids[3]!);
    const run = (principalId: string, interactionId: string, command: Parameters<typeof applyDiscordCommand>[1], at: number,
      runner = 'db-discord-runner') => {
      const slot = command.type === 'checkin' ? 'checkin' : 'matchId' in command ? command.matchId : null;
      const id = slot === 'checkin' ? ids[0]! : slot === 'M1' ? ids[2]! : slot === 'M2' ? ids[3]! : null;
      return applyDiscordCommand({ config: changed, eventId: session.event_id, principalId, interactionId,
        ...(config.adminId !== principalId && id && slot ? { message: { slot, id, channelId: changed.channelId } } : {}) }, command, runner, () => at);
    };
    await run(changed.players.C, ids[5]!, { type: 'checkin' }, 2_100);
    await run(changed.players.D, ids[6]!, { type: 'checkin' }, 2_200);
    await run(changed.adminId, ids[7]!, { type: 'publish' }, 2_300);
    await run(changed.players.A, '101010101010101010', { type: 'ready', matchId: 'M1' }, 3_000);
    await run(changed.players.B, '111010101010101010', { type: 'ready', matchId: 'M1' }, 4_000);
    let rejectedClockCalls = 0;
    await assert.rejects(applyDiscordCommand({ config: changed, eventId: session.event_id,
      principalId: changed.players.C, interactionId: '121010101010101010', message: { slot: 'M2', id: ids[3]!, channelId: changed.channelId } },
      { type: 'ready', matchId: 'M2' }, 'new-runner', () => { rejectedClockCalls++; return 80_000; }), /interrupted/);
    assert.equal(rejectedClockCalls, 0, 'old running ownership rejects before time sampling');
    await run(changed.players.A, '131010101010101010', { type: 'pause', matchId: 'M1' }, 5_000);
    assert.equal((await run(changed.players.A, '141010101010101010',
      { type: 'resumeConsent', matchId: 'M1', pauseGeneration: 1 }, 6_000, 'new-runner')).applied, true);
    assert.deepEqual(await claimResumeReminder(changed, session.event_id, 'M1', 1), [changed.players.B]);
    assert.equal(await claimResumeReminder(changed, session.event_id, 'M1', 1), null,
      'a pause generation can claim one notification attempt');
    await run(changed.players.B, '151010101010101010',
      { type: 'resumeConsent', matchId: 'M1', pauseGeneration: 1 }, 7_000, 'new-runner');
    assert.equal(await claimResumeReminder(changed, session.event_id, 'M1', 1), null,
      'running match cannot claim a paused-player reminder');
    const running = (await getSessionState(changed)).state.matches[0];
    const deadline = running.startedAtMs! + running.remainingMs;
    const beforeTimer = (await getSessionState(changed)).state.version;
    const auditBeforeTimer = await withClient(client => client.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM public.tcg_rehearsal_audit WHERE event_id=$1', [session.event_id]));
    const timer = (generation: number, at: number) => applyDiscordCommand({ config: changed, eventId: session.event_id,
      principalId: 'system:timer', timer: { matchId: 'M1', pauseGeneration: generation, deadlineMs: deadline } },
      { type: 'clockCheck', matchId: 'M1' }, 'new-runner', () => at);
    assert.equal((await timer(0, deadline)).applied, false, 'wrong generation is obsolete');
    assert.equal((await timer(1, deadline - 1)).applied, false, 'early callback is a no-op');
    assert.equal((await getSessionState(changed)).state.version, beforeTimer);
    const auditAfterNoops = await withClient(client => client.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM public.tcg_rehearsal_audit WHERE event_id=$1', [session.event_id]));
    assert.equal(auditAfterNoops.rows[0]?.count, auditBeforeTimer.rows[0]?.count);
    const expired = await applyDiscordCommand({ config: changed, eventId: session.event_id,
      principalId: 'system:timer', timer: { matchId: 'M1', pauseGeneration: 1, deadlineMs: deadline } },
      { type: 'clockCheck', matchId: 'M1' }, 'new-runner', () => deadline);
    assert.equal(expired.applied, true);
    assert.equal((await getSessionState(changed)).state.matches[0].phase, 'expired');
    assert.equal((await run(changed.players.A, '161010101010101010',
      { type: 'propose', matchId: 'M1', winner: 'A', expectedRevision: 0 }, deadline + 1, 'third-runner')).applied, true);

    assert.equal(await suspendStickyCard(changed, session.event_id, 'M2', ids[3]!), true);
    assert.equal(await suspendStickyCard(changed, session.event_id, 'M2', ids[3]!), false);
    assert.deepEqual((await getSessionState(changed)).session.identity_map.stickySuspended, ['M2']);
    assert.equal(await replaceStickyCard(changed, session.event_id, 'M2', ids[2]!, ids[4]!), false);
    assert.equal(await replaceStickyCard(changed, session.event_id, 'M2', ids[3]!, ids[4]!), true);
    assert.equal((await getSessionState(changed)).session.m2_message_id, ids[4]);
    await completeStickyCard(changed, session.event_id, 'M2', ids[4]!);
    assert.deepEqual((await getSessionState(changed)).session.identity_map.stickySuspended, []);

    // Retirement under the same aggregate lock wins over an already queued click.
    await withClient(async client => {
      await client.query('BEGIN');
      try {
        await client.query('SELECT id FROM public.tcg_rehearsal_events WHERE id=$1 FOR UPDATE', [session.event_id]);
        const pending = run(changed.players.A, '171010101010101010', { type: 'callJudge', matchId: 'M1' }, deadline + 2, 'third-runner');
        await new Promise(resolve => setTimeout(resolve, 50));
        await client.query("UPDATE public.tcg_rehearsal_sessions SET status='retired', retired_at_ms=$2 WHERE event_id=$1",
          [session.event_id, deadline + 2]);
        await client.query('COMMIT');
        await assert.rejects(pending, /retired/);
      } finally { await client.query('ROLLBACK').catch(() => {}); }
    });

    // The retired legacy session leaves the global active slot free for signup.
    const signupConfig = { applicationId: config.applicationId, guildId: config.guildId,
      channelId: config.channelId, adminId: config.adminId, mode: 'signup' as const };
    const signupSession = await prepareSignupSession(signupConfig);
    await bindCard(signupConfig, signupSession.event_id, 'checkin', ids[0]!);
    const frozenIdentity = (await getSessionState(signupConfig)).session.identity_map;
    let sequence = 20;
    const signupRun = (principalId: string, command: Parameters<typeof applyDiscordCommand>[1],
      card = false) => applyDiscordCommand({ config: signupConfig, eventId: signupSession.event_id,
        principalId, interactionId: `${sequence++}1010101010101010`, ...(card ?
          { message: { slot: 'checkin' as const, id: ids[0]!, channelId: signupConfig.channelId } } : {}) },
      command, 'signup-db-runner', () => 10_000 + sequence);
    await assert.rejects(signupRun(signupConfig.adminId, { type: 'signupJoin' }, true), /member action denied/);
    await assert.rejects(signupRun(ids[3]!, { type: 'signupJoin' }), /canonical card/);
    await assert.rejects(applyDiscordCommand({ config: signupConfig, eventId: signupSession.event_id,
      principalId: ids[3]!, interactionId: '301010101010101010',
      message: { slot: 'checkin', id: ids[1]!, channelId: signupConfig.channelId } },
    { type: 'signupJoin' }, 'signup-db-runner'), /canonical/);
    const joins = await Promise.all([signupRun(ids[3]!, { type: 'signupJoin' }, true),
      signupRun(ids[4]!, { type: 'signupJoin' }, true)]);
    assert.ok(joins.every(outcome => outcome.applied));
    const duplicate = await signupRun(ids[3]!, { type: 'signupJoin' }, true);
    assert.equal(duplicate.applied, false);
    await assert.rejects(signupRun(signupConfig.adminId,
      { type: 'signupClose', adminId: signupConfig.adminId }), /four distinct/);
    await signupRun(ids[5]!, { type: 'signupJoin' }, true);
    await signupRun(ids[6]!, { type: 'signupJoin' }, true);
    const beforeClose = await getSessionState(signupConfig);
    assert.equal(beforeClose.state.version, 4);
    await assert.rejects(signupRun(ids[8]!, { type: 'signupJoin' }, true), /full/);
    const closed = await signupRun(signupConfig.adminId,
      { type: 'signupClose', adminId: signupConfig.adminId });
    assert.match(closed.result, /signupClose.*A.*B.*C.*D/);
    const afterClose = await getSessionState(signupConfig);
    assert.deepEqual(afterClose.state.signup?.assignment,
      { A: beforeClose.state.signup!.roster[0], B: beforeClose.state.signup!.roster[1],
        C: beforeClose.state.signup!.roster[2], D: beforeClose.state.signup!.roster[3] });
    assert.deepEqual(afterClose.session.identity_map, frozenIdentity);
    await assert.rejects(signupRun(ids[8]!, { type: 'signupJoin' }, true), /closed/);
    await assert.rejects(signupRun(ids[8]!, { type: 'checkin' }, true), /not in the private fixture/);
    await signupRun(beforeClose.state.signup!.roster[0]!, { type: 'checkin' }, true);
    await signupRun(signupConfig.adminId, { type: 'signupReopen' });
    const reopened = await getSessionState(signupConfig);
    assert.deepEqual(reopened.state.checkins, []);
    assert.equal(reopened.state.signup?.assignment, undefined);
    assert.deepEqual(reopened.session.identity_map, frozenIdentity);
    await signupRun(signupConfig.adminId, { type: 'signupRemove', memberId: ids[6]! });
    await signupRun(ids[8]!, { type: 'signupJoin' }, true);
    await signupRun(signupConfig.adminId, { type: 'signupClose', adminId: signupConfig.adminId });
    const fresh = await getSessionState(signupConfig);
    assert.equal(fresh.state.signup?.assignment?.D, ids[8]);
    for (const id of [ids[3]!, ids[4]!, ids[5]!, ids[8]!]) await signupRun(id, { type: 'checkin' }, true);
    await signupRun(signupConfig.adminId, { type: 'publish' });
    await assert.rejects(signupRun(signupConfig.adminId, { type: 'signupReopen' }), /unavailable/);
    const signupAudit = await withClient(client => client.query<{ action: { type: string }; outcome: { result: string } }>(
      'SELECT action,outcome FROM public.tcg_rehearsal_audit WHERE event_id=$1 ORDER BY sequence', [signupSession.event_id]));
    assert.equal(signupAudit.rows.length, (await getSessionState(signupConfig)).state.version,
      'duplicate and rejected commands do not create audit entries');
    assert.equal(signupAudit.rows.filter(row => row.action.type === 'signupClose').length, 2);
    assert.ok(signupAudit.rows.filter(row => row.action.type === 'signupClose').every(row => row.outcome.result.includes('"A"')));
    const publicConfig = { ...signupConfig, publicMatchRooms: true,
      matchChannels: { M1: ids[3]!, M2: ids[4]! } };
    const publicSession = await prepareSignupSession(publicConfig, true);
    assert.equal((await getSessionState(publicConfig)).session.identity_map.publicMatchRooms, true);
    assert.equal((await getSessionState(publicConfig)).session.event_id, publicSession.event_id);
    await assert.rejects(getSessionState({ ...publicConfig, publicMatchRooms: false }), /configuration differs/);
  });
