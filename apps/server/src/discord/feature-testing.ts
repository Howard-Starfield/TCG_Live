// Test helper for Discord features: a DiscordFeatureContext with in-memory defaults. Override what the
// feature under test uses (client, guild(), settings...). Never used by the running bot.
import type { Client } from 'discord.js';
import { DEFAULT_ADMIN_TOOLS_SETTINGS, DEFAULT_MODERATION_SETTINGS, type AdminToolsSettingsBodyDto,
  type ModerationSettingsBodyDto } from '@tcg-live/core';
import { MemoryEvidenceStore } from '../evidence/store.js';
import { MemoryOpsAuditStore } from '../ops/audit.js';
import { AdminToolsRuntimeState } from '../admin-tools/status.js';
import { MemoryVoiceBotRegistry } from '../voice/tokens.js';
import { DiscordFeatureEvents, type DiscordFeatureContext } from './features.js';
import { FeatureInteractionRouter } from './interactions.js';

export const TEST_GUILD_ID = '123456789012345678';
export const TEST_APPLICATION_ID = '111111111111111111';

export interface FakeFeatureContext extends DiscordFeatureContext {
  readonly events: DiscordFeatureEvents;
  readonly router: FeatureInteractionRouter;
  readonly auditStore: MemoryOpsAuditStore;
  readonly logs: string[];
}

export function fakeFeatureContext(overrides: Partial<DiscordFeatureContext> = {},
  settings: AdminToolsSettingsBodyDto = structuredClone(DEFAULT_ADMIN_TOOLS_SETTINGS) as AdminToolsSettingsBodyDto): FakeFeatureContext {
  const events = new DiscordFeatureEvents();
  const router = new FeatureInteractionRouter({ applicationId: TEST_APPLICATION_ID, guildId: TEST_GUILD_ID });
  const auditStore = new MemoryOpsAuditStore();
  const logs: string[] = [];
  const status = new AdminToolsRuntimeState([], 'discord');
  const adminTools = () => ({ guildId: TEST_GUILD_ID, version: 0, updatedAtMs: null, ...structuredClone(settings) });
  return {
    events, router, auditStore, logs,
    client: {} as Client, guildId: TEST_GUILD_ID, adminId: '999999999999999999', isActive: () => true,
    staffRoleOf: async () => null,
    moderationSettings: async () => ({ guildId: TEST_GUILD_ID, version: 0, updatedAtMs: null,
      ...structuredClone(DEFAULT_MODERATION_SETTINGS) as ModerationSettingsBodyDto }),
    appendFlag: async () => { throw new Error('appendFlag is not faked'); },
    appendAudit: input => auditStore.append(input),
    evidence: new MemoryEvidenceStore(auditStore),
    voiceBots: new MemoryVoiceBotRegistry(),
    publishVoicePool: () => {},
    on: (type, listener) => events.on(type, listener),
    matchRoom: async () => null,
    activeMatchRooms: async () => [],
    log: message => { logs.push(message); },
    guild: async () => { throw new Error('guild() is not faked; pass a fake Guild in overrides.'); },
    adminToolsSettings: async () => adminTools(),
    adminToolsStatus: async () => status.describe(settings),
    privilegedIntents: () => status.privilegedIntents(),
    audit: (kind, payload = {}, actor = { kind: 'bot', id: 'bot' }) => auditStore.append({ kind, actor, guildId: TEST_GUILD_ID, payload }),
    tournamentMembers: async () => null,
    reservedChannelIds: async () => [],
    interactions: router,
    ...overrides
  };
}
