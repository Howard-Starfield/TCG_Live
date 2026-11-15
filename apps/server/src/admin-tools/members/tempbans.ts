// Tempban expiry (agent G1): a ban case with expiresAtMs is lifted by the bot once it expires. Runs on
// start (catch-up after a restart) and then every minute. Each lift opens an `unban` case by the bot and
// writes `member.tempban_expired`; the ban case is then marked handled so it is never lifted twice.
import type { OpsActor } from '../../ops/audit.js';
import type { MembersBackend } from './backend.js';
import { discordReason } from './routes.js';
import type { ModCaseStore } from './store.js';

export const TEMPBAN_CHECK_MS = 60_000;
const BOT: OpsActor = { kind: 'bot', id: 'bot' };

export interface TempbanDeps {
  guildId: string;
  now(): number;
  backend: MembersBackend;
  cases: ModCaseStore;
  /** Writes `member.tempban_expired` (tcg_ops_audit, bot actor). */
  audit(payload: Record<string, unknown>): Promise<unknown>;
  log?(message: string): void;
}

export type TempbanOutcome = 'unbanned' | 'already_unbanned' | 'superseded' | 'failed';

/** Lifts every due tempban once. Failures stay due and are retried on the next pass. */
export async function liftExpiredTempbans(deps: TempbanDeps, limit = 25): Promise<Array<{ caseNumber: number; outcome: TempbanOutcome }>> {
  if (!deps.cases.dueTempbans || !deps.cases.markExpiryHandled) return [];
  const due = await deps.cases.dueTempbans(deps.guildId, deps.now(), limit);
  const results: Array<{ caseNumber: number; outcome: TempbanOutcome }> = [];
  for (const item of due) {
    let outcome: TempbanOutcome;
    let unbanCaseNumber: number | null = null;
    try {
      // A later ban (permanent or another tempban) replaces this one: never lift it early.
      const latest = (await deps.cases.latestBans(deps.guildId, [item.targetId])).get(item.targetId);
      if (latest && latest.number !== item.number) outcome = 'superseded';
      else if (!(await deps.backend.target(item.targetId)).banned) outcome = 'already_unbanned';
      else {
        const reason = `Temporary ban (case #${item.number}) expired.`;
        const unban = await deps.cases.create(deps.guildId, { kind: 'unban', targetId: item.targetId, reason, evidenceIds: [],
          eventId: item.eventId, matchId: item.matchId, source: 'discord', expiresAtMs: null }, BOT,
        async number => { await deps.backend.apply(item.targetId, { kind: 'unban' }, discordReason(number, reason)); });
        unbanCaseNumber = unban.number;
        outcome = 'unbanned';
      }
      await deps.cases.markExpiryHandled(deps.guildId, item.number, deps.now());
      await deps.audit({ caseNumber: item.number, targetId: item.targetId, outcome, unbanCaseNumber, expiresAtMs: item.expiresAtMs })
        .catch(() => {});
    } catch {
      outcome = 'failed';
      deps.log?.(`Tempban case #${item.number} could not be lifted yet; retrying in a minute.`);
    }
    results.push({ caseNumber: item.number, outcome });
  }
  return results;
}
