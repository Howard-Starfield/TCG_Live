// Demo data for the LFG tab (npm run admin:demo): settings on #general, a few open, closed and expired posts.
import { DEFAULT_LFG_SETTINGS, type LfgSettingsBodyDto } from '@tcg-live/core';
import { LOCAL_ADMIN } from '../../ops/audit.js';
import { DEMO_CHANNEL_IDS, DEMO_ROLE_IDS } from '../demo-guild.js';
import type { AdminToolsRouteDeps } from '../module.js';
import { lfgFirstMessage } from './messages.js';
import type { LfgGateway } from './service.js';
import type { LfgSettingsStore } from './settings.js';
import type { LfgPostStore } from './store.js';

const MINUTE = 60_000;

export async function seedLfgDemo(input: { deps: AdminToolsRouteDeps; settings: LfgSettingsStore; posts: LfgPostStore; gateway: LfgGateway }): Promise<void> {
  const { deps, posts } = input;
  if (!deps.demo) return;
  const guildId = deps.guildId();
  if ((await input.settings.get(guildId)).version > 0) return;
  const body: LfgSettingsBodyDto = { ...structuredClone(DEFAULT_LFG_SETTINGS) as LfgSettingsBodyDto, enabled: true,
    channels: [{ channelId: DEMO_CHANNEL_IDS.general, panel: null, games: [], pingRoleId: null, voiceChannelIds: null }],
    games: [{ name: 'Pokémon TCG', emoji: '⚡', pingRoleId: null }, { name: 'Magic: The Gathering', emoji: '🧙', pingRoleId: null },
      { name: 'Yu-Gi-Oh!', emoji: '🃏', pingRoleId: null }, { name: 'One Piece', emoji: '🏴‍☠️', pingRoleId: null }],
    formats: ['Standard', 'Expanded', 'Casual', 'Draft'], pingRoleId: DEMO_ROLE_IDS.lfg };
  const saved = await input.settings.put(guildId, 0, body, LOCAL_ADMIN);
  const people = deps.demo.members.filter(member => !member.bot).map(member => member.id);
  const now = deps.now();
  const plan = [
    { author: 0, game: 'Pokémon TCG', format: 'Standard', note: 'Testing a new Lugia deck, chill games.', ago: 20, joiners: [1, 2], end: null },
    { author: 3, game: 'One Piece', format: 'Casual', note: null, ago: 50, joiners: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25], end: null },
    { author: 5, game: 'Magic: The Gathering', format: 'Draft', note: 'Need 6 more for a cube draft tonight.', ago: 300, joiners: [6, 7], end: 'closed' as const },
    { author: 8, game: 'Yu-Gi-Oh!', format: null, note: null, ago: 600, joiners: [], end: 'expired' as const }
  ];
  for (const item of plan) {
    const author = people[item.author];
    if (!author) continue;
    const created = now - item.ago * MINUTE;
    const result = await posts.create({ guildId, channelId: DEMO_CHANNEL_IDS.general, authorId: author, game: item.game, format: item.format,
      note: item.note, voiceChannelId: null, nowMs: created, expiresAtMs: created + saved.expiryMinutes * MINUTE, cooldownMs: 0, maxOpen: 0,
      pingRoleId: item.ago === 20 ? DEMO_ROLE_IDS.lfg : null, pingCooldownMs: 0 });
    if (result.kind !== 'created') continue;
    const messageId = await input.gateway.send(DEMO_CHANNEL_IDS.general, lfgFirstMessage(result.post, saved));
    await posts.setMessage(guildId, result.post.id, messageId);
    for (const [index, joiner] of item.joiners.entries()) {
      const id = people[joiner];
      if (id) await posts.join(guildId, result.post.id, id, created + (index + 1) * MINUTE);
    }
    if (item.end) await posts.close(guildId, result.post.id, item.end, item.end === 'expired' ? 'expired' : 'author', created + 90 * MINUTE);
  }
}
