// Demo data for the Cases tab (`npm run admin:demo`): two warnings and a timeout on synthetic
// members, so the case log, the audit trail and member profiles have something to show. Synthetic text only.
import type { ModCaseKind } from '@tcg-live/core';
import { LOCAL_ADMIN } from '../../ops/audit.js';
import type { AdminToolsRouteDeps } from '../module.js';
import type { ModCaseStore } from './store.js';
import type { DemoGuild } from '../demo-guild.js';

const HOUR = 3_600_000;

/** Only the real `npm run admin:demo` server seeds (tests build demo guilds too and count cases from #1). */
const seeded = new WeakSet<DemoGuild>();
export function enableDemoCaseSeed(demo: DemoGuild): void { seeded.add(demo); }

export function seedDemoCases(cases: ModCaseStore, deps: AdminToolsRouteDeps): void {
  const demo = deps.demo;
  if (!demo || !seeded.has(demo)) return;
  seeded.delete(demo);
  const humans = demo.members.filter(member => !member.bot);
  const plan: Array<{ kind: ModCaseKind; index: number; reason: string; expiresInMs: number | null }> = [
    { kind: 'warn', index: 5, reason: 'Slow play warning after a judge call in round 2.', expiresInMs: null },
    { kind: 'timeout', index: 7, reason: 'Repeated trash talk in the match room.', expiresInMs: HOUR },
    { kind: 'warn', index: 7, reason: 'Posted a decklist link in #general after being asked to use #decks.', expiresInMs: null }
  ];
  const write = async () => {
    const guildId = deps.guildId();
    for (const item of plan) {
      const member = humans[item.index];
      if (!member) continue;
      await cases.create(guildId, { kind: item.kind, targetId: member.id, reason: item.reason, evidenceIds: [], eventId: null, matchId: null,
        source: 'dashboard', expiresAtMs: item.expiresInMs === null ? null : deps.now() + item.expiresInMs }, LOCAL_ADMIN, async () => {});
    }
  };
  void write().catch(() => {});
}
