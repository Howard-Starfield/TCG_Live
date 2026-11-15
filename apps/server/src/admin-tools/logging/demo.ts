// Demo data for the Logs tab (`npm run admin:demo`): joins with a new-account flag, a leave, role and
// nickname changes, and a few message edits/deletes. Synthetic text only.
import { DEMO_CHANNEL_IDS, DEMO_ROLE_IDS, type DemoGuild } from '../demo-guild.js';
import type { MemoryLoggingStore } from './store.js';

const HOUR = 3_600_000;

export function seedDemoLogs(store: MemoryLoggingStore, demo: DemoGuild, nowMs: number): void {
  const humans = demo.members.filter(member => !member.bot);
  const at = (hoursAgo: number) => nowMs - hoursAgo * HOUR;
  const write = async () => {
    for (const [index, member] of humans.slice(-6).entries()) {
      const newAccount = index >= 4;
      await store.recordMemberEvent(demo.id, { kind: 'join', userId: member.id, occurredAtMs: at(72 - index * 6),
        detail: { newAccount, accountCreatedAtMs: newAccount ? at(80) : member.accountCreatedAtMs } });
    }
    await store.recordMemberEvent(demo.id, { kind: 'role', userId: humans[3]!.id, occurredAtMs: at(30),
      detail: { addedRoleIds: [DEMO_ROLE_IDS.season3], removedRoleIds: [] } });
    await store.recordMemberEvent(demo.id, { kind: 'nick', userId: humans[4]!.id, occurredAtMs: at(20),
      detail: { before: null, after: 'Yugi the Judge' } });
    await store.recordMemberEvent(demo.id, { kind: 'leave', userId: humans[10]!.id, occurredAtMs: at(5), detail: {} });
    const general = DEMO_CHANNEL_IDS.general;
    const id = (n: number) => `30000000000000${String(n).padStart(4, '0')}`;
    await store.recordMessageEvent(demo.id, { kind: 'edit', channelId: general, messageId: id(1), authorId: humans[2]!.id,
      before: 'gg, i won 2-0', after: 'gg, I won 2-1 actually', attachmentCount: 0, occurredAtMs: at(10) });
    await store.recordMessageEvent(demo.id, { kind: 'delete', channelId: general, messageId: id(2), authorId: humans[7]!.id,
      before: 'anyone want to trade a foil?', after: null, attachmentCount: 1, occurredAtMs: at(4) });
    await store.recordMessageEvent(demo.id, { kind: 'delete', channelId: DEMO_CHANNEL_IDS.support, messageId: id(3), authorId: humans[9]!.id,
      before: 'how do I report my match?', after: null, attachmentCount: 0, occurredAtMs: at(1) });
    await store.storeMessage(demo.id, { messageId: id(4), channelId: general, authorId: humans[1]!.id, content: 'round 3 pairings are up',
      attachmentCount: 0, createdAtMs: at(2), editedAtMs: null });
  };
  // The memory store resolves synchronously; the seed is done before the first request.
  void write();
}
