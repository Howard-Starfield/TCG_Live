// The only list later phases edit to add a Discord feature. Each call returns fresh instances, so a
// restarted runtime never reuses a stopped feature. Order is start order; stop runs in reverse.
import type { DiscordFeature } from './features.js';
import { autoModFeature } from '../moderation/automod-feature.js';
import { evidenceSubmitFeature } from '../evidence/discord-submit.js';
import { evidenceRetentionFeature } from '../evidence/retention.js';
import { voiceFeature } from '../voice/feature.js';

export function discordFeatures(): DiscordFeature[] {
  return [autoModFeature(), evidenceSubmitFeature(), evidenceRetentionFeature(), voiceFeature()];
}
