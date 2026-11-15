// Admin tools runtime status: which privileged intents the running gateway has, whether the saved settings
// now want a different set (restart required), and each Discord feature's state. Shared by the route
// (GET /api/v1/admin-tools/status), ctx.adminToolsStatus() and the demo.
import { PRIVILEGED_INTENT_NAMES, PRIVILEGED_INTENT_PORTAL_LABELS, type AdminToolsFeatureStatusDto, type AdminToolsSettingsBodyDto,
  type AdminToolsStatusDto, type PrivilegedIntentName, type PrivilegedIntentState } from '@tcg-live/core';
import type { DiscordFeature } from '../discord/features.js';
import { featurePrivilegedIntents } from '../discord/intents.js';

export interface AdminToolsLoginState {
  /** Privileged intents the login asked for (before any fallback). */
  requested: readonly PrivilegedIntentName[];
  /** The subset Discord refused; the gateway runs without them. */
  missing: readonly PrivilegedIntentName[];
}

const labels = (names: readonly PrivilegedIntentName[]) => names.map(name => PRIVILEGED_INTENT_PORTAL_LABELS[name]).join(' and ');

/** Mutable holder: the Discord runtime records login and feature start; routes and features read it. */
export class AdminToolsRuntimeState {
  private login: AdminToolsLoginState | null = null;
  private started = new Set<string>();
  private failed = new Set<string>();

  constructor(private readonly features: readonly DiscordFeature[], private readonly mode: 'discord' | 'demo') {}

  recordLogin(state: AdminToolsLoginState): void {
    this.login = { requested: [...state.requested], missing: [...state.missing] };
  }
  recordFeatures(result: { started: readonly string[]; failed: readonly string[] }): void {
    this.started = new Set(result.started);
    this.failed = new Set(result.failed);
  }
  recordStopped(): void { this.login = null; this.started.clear(); }

  /** What the running gateway has. */
  privilegedIntents(): Record<PrivilegedIntentName, PrivilegedIntentState> {
    const login = this.login;
    return Object.fromEntries(PRIVILEGED_INTENT_NAMES.map(name => [name,
      !login || !login.requested.includes(name) ? 'off' : login.missing.includes(name) ? 'missing' : 'on'])) as
      Record<PrivilegedIntentName, PrivilegedIntentState>;
  }

  describe(settings: AdminToolsSettingsBodyDto): AdminToolsStatusDto {
    const wantedList = [...new Set(this.features.flatMap(feature => featurePrivilegedIntents(feature, settings)))];
    const wantedIntents = Object.fromEntries(PRIVILEGED_INTENT_NAMES.map(name => [name, wantedList.includes(name)])) as
      Record<PrivilegedIntentName, boolean>;
    const features = (missing: readonly PrivilegedIntentName[], running: boolean): AdminToolsFeatureStatusDto[] =>
      this.features.map(feature => {
        const missingIntents = featurePrivilegedIntents(feature, settings).filter(name => missing.includes(name));
        const state = this.failed.has(feature.name) ? 'failed' as const : !running || !this.started.has(feature.name) ? 'stopped' as const
          : missingIntents.length ? 'intent-missing' as const : 'running' as const;
        return { name: feature.name, state, missingIntents };
      });
    if (this.mode === 'demo') {
      return { runtime: 'demo', wantedIntents, restartRequired: false, restartReason: null, features: [],
        privilegedIntents: Object.fromEntries(PRIVILEGED_INTENT_NAMES.map(name => [name, wantedIntents[name] ? 'on' : 'off'])) as
          Record<PrivilegedIntentName, PrivilegedIntentState> };
    }
    const login = this.login;
    if (!login) {
      return { runtime: 'offline', wantedIntents, restartRequired: false, restartReason: null, features: features([], false),
        privilegedIntents: this.privilegedIntents() };
    }
    const stillMissing = login.missing.filter(name => wantedIntents[name]);
    const added = PRIVILEGED_INTENT_NAMES.filter(name => wantedIntents[name] && !login.requested.includes(name));
    const dropped = PRIVILEGED_INTENT_NAMES.filter(name => !wantedIntents[name] && login.requested.includes(name));
    let restartReason: string | null = null;
    if (stillMissing.length) restartReason = `Discord refused the ${labels(stillMissing)}. Turn ${stillMissing.length > 1 ? 'them' : 'it'} on in the ` +
      'Discord Developer Portal (your application > Bot > Privileged Gateway Intents), then restart the bot.';
    else if (added.length) restartReason = `The saved settings need the ${labels(added)}. Make sure ${added.length > 1 ? 'they are' : 'it is'} ` +
      'turned on in the Discord Developer Portal, then restart the bot to apply.';
    else if (dropped.length) restartReason = `The ${labels(dropped)} ${dropped.length > 1 ? 'are' : 'is'} no longer needed. Restart the bot to stop requesting ${dropped.length > 1 ? 'them' : 'it'}.`;
    return { runtime: 'running', privilegedIntents: this.privilegedIntents(), wantedIntents,
      restartRequired: restartReason !== null, restartReason, features: features(login.missing, true) };
  }
}
