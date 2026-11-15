// The only list later phases edit to add a Discord feature. Each call returns fresh instances, so a
// restarted runtime never reuses a stopped feature. Order is start order; stop runs in reverse.
// Admin-tools feature agents append their feature after adminToolsCoreFeature() (one line each).
import type { DiscordFeature } from './features.js';
import { adminToolsCoreFeature } from '../admin-tools/discord-feature.js';
import { stickiesTicketsFeature } from '../admin-tools/channels/discord-feature.js';
import { loggingFeature } from '../admin-tools/logging/feature.js';
import { rolesFeature } from '../admin-tools/roles/feature.js';
import { announcementsFeature } from '../admin-tools/announcements/feature.js';
import { autoModFeature } from '../moderation/automod-feature.js';
import { evidenceSubmitFeature } from '../evidence/discord-submit.js';
import { evidenceRetentionFeature } from '../evidence/retention.js';
import { voiceFeature } from '../voice/feature.js';

export function discordFeatures(): DiscordFeature[] {
  return [
    autoModFeature(), evidenceSubmitFeature(), evidenceRetentionFeature(), voiceFeature(),
    adminToolsCoreFeature(),
    stickiesTicketsFeature(),
    loggingFeature(),
    rolesFeature(), announcementsFeature(),
    // (A) members/cases feature, (B) stickies/channels/tickets feature, (C) button roles/bulk roles/announcements
    // feature, (D) logging/welcome/auto-role feature: append here.
  ];
}
