// /tcg-admin moderation authorization: TCG Organizer (and the server owner) or a Discord permission holder; a TCG Judge,
// a legacy staff role (counts as judge) and the old organizer ID are refused.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PermissionFlagsBits } from 'discord.js';
import { ADMIN_COMMAND_NAME } from '../../discord/admin-command.js';
import { fakeFeatureContext, TEST_APPLICATION_ID, TEST_GUILD_ID } from '../../discord/feature-testing.js';
import { judgeDenied, STAFF_DENIED, type ResolvedStaff } from '../../discord/staff.js';
import { membersDiscordFeature } from './discord-feature.js';
import { MemoryModCaseStore, MemoryModNoteStore } from './store.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
const ORGANIZER = '210000000000000001';
const JUDGE = '210000000000000002';
const LEGACY = '210000000000000003';
const OLD_ADMIN = '999999999999999999';
const MODERATOR = '210000000000000005';

const staffRoleOf = async ({ userId }: { userId: string }): Promise<ResolvedStaff | null> =>
  userId === ORGANIZER ? { role: 'organizer', via: 'role' }
    : userId === JUDGE ? { role: 'judge', via: 'role' }
      : userId === LEGACY ? { role: 'judge', via: 'legacy-staff-role' } : null;

async function warn(userId: string, permissions: bigint[] = []): Promise<string> {
  const ctx = fakeFeatureContext({ staffRoleOf, adminId: OLD_ADMIN });
  const feature = membersDiscordFeature({ cases: () => new MemoryModCaseStore(ctx.auditStore), notes: () => new MemoryModNoteStore(ctx.auditStore),
    backend: () => ({ botUserId: null }) as never, checkEveryMs: 3_600_000 });
  await feature.start(ctx);
  const replies: string[] = [];
  const interaction = {
    id: 'i', applicationId: TEST_APPLICATION_ID, guildId: TEST_GUILD_ID, channelId: '333333333333333333', user: { id: userId },
    member: { roles: [] }, guild: { ownerId: '210000000000000009' }, memberPermissions: { has: (flag: bigint) => permissions.includes(flag) },
    commandName: ADMIN_COMMAND_NAME, isChatInputCommand: () => true, isButton: () => false, isModalSubmit: () => false,
    isMessageComponent: () => false,
    options: { getSubcommand: () => 'warn', getUser: () => ({ id: userId }), getString: () => 'reason' },
    async deferReply() {}, async editReply(options: { content: string }) { replies.push(options.content); }
  };
  ctx.router.dispatch(interaction as never);
  await settle(); await settle();
  await feature.stop();
  return replies[0]!;
}

test('moderation: an organizer passes the gate; a judge, a legacy staff role, the old organizer ID and outsiders are refused', async () => {
  // Past the gate the self-target check answers, which needs no backend.
  assert.equal(await warn(ORGANIZER), 'You cannot moderate yourself.');
  assert.equal(await warn(JUDGE), judgeDenied('moderation'));
  assert.equal(await warn(LEGACY), judgeDenied('moderation'));
  assert.equal(await warn(OLD_ADMIN), STAFF_DENIED, 'adminId is no longer an exemption');
  assert.equal(await warn('210000000000000008'), STAFF_DENIED);
  // Discord permission holders keep working as before.
  assert.equal(await warn(MODERATOR, [PermissionFlagsBits.ModerateMembers]), 'You cannot moderate yourself.');
  assert.match(judgeDenied('moderation'), /TCG Judge cannot moderate members/);
});
