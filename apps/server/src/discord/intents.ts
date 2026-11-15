// Gateway intent planning with opt-in privileged intents (docs/ADMIN_TOOLS_PROPOSAL.md, Decisions).
// The requested set is computed once at login from the enabled features and the saved admin-tools
// settings. If Discord refuses it with "Disallowed intents" (close code 4014), the bot logs in again
// without the privileged intents, reports them as missing and keeps running.
import { GatewayIntentBits } from 'discord.js';
import { PRIVILEGED_INTENT_NAMES, type AdminToolsSettingsBodyDto, type PrivilegedIntentName } from '@tcg-live/core';
import type { DiscordFeature } from './features.js';

export const PRIVILEGED_INTENT_BITS: Readonly<Record<PrivilegedIntentName, GatewayIntentBits>> = {
  guildMembers: GatewayIntentBits.GuildMembers,
  messageContent: GatewayIntentBits.MessageContent
};
/** GuildPresences is privileged too; no feature may request it. */
const FORBIDDEN = new Set<GatewayIntentBits>([GatewayIntentBits.GuildPresences]);

export function privilegedNameOf(bit: GatewayIntentBits): PrivilegedIntentName | null {
  return PRIVILEGED_INTENT_NAMES.find(name => PRIVILEGED_INTENT_BITS[name] === bit) ?? null;
}

/** Discord's close code for privileged intents that are not enabled in the Developer Portal. */
export const DISALLOWED_INTENTS_CLOSE_CODE = 4014;

/** Every intent one feature wants for these settings (static plus conditional). */
export function featureIntentsFor(feature: DiscordFeature, settings: AdminToolsSettingsBodyDto): GatewayIntentBits[] {
  let conditional: readonly GatewayIntentBits[] = [];
  try { conditional = feature.intentsFor?.(settings) ?? []; } catch { conditional = []; }
  return [...new Set([...(feature.intents ?? []), ...conditional])].filter(bit => !FORBIDDEN.has(bit));
}

/** Privileged intents one feature needs for these settings. */
export function featurePrivilegedIntents(feature: DiscordFeature, settings: AdminToolsSettingsBodyDto): PrivilegedIntentName[] {
  const wanted = new Set(featureIntentsFor(feature, settings));
  return PRIVILEGED_INTENT_NAMES.filter(name => wanted.has(PRIVILEGED_INTENT_BITS[name]));
}

export interface IntentPlan {
  /** Everything to request (base + features). */
  intents: GatewayIntentBits[];
  /** The privileged subset, by name. */
  privileged: PrivilegedIntentName[];
}

export function planIntents(base: readonly GatewayIntentBits[], features: readonly DiscordFeature[],
  settings: AdminToolsSettingsBodyDto): IntentPlan {
  const intents = [...new Set([...base, ...features.flatMap(feature => featureIntentsFor(feature, settings))])]
    .filter(bit => !FORBIDDEN.has(bit));
  const set = new Set(intents);
  return { intents, privileged: PRIVILEGED_INTENT_NAMES.filter(name => set.has(PRIVILEGED_INTENT_BITS[name])) };
}

export function withoutPrivileged(plan: IntentPlan): IntentPlan {
  const privileged = new Set(plan.privileged.map(name => PRIVILEGED_INTENT_BITS[name]));
  return { intents: plan.intents.filter(bit => !privileged.has(bit)), privileged: [] };
}

/** The minimal surface of a discord.js Client used here (fakes in tests). */
export interface IntentGateway {
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  destroy(): Promise<void> | void;
}

export function isDisallowedIntentsError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return code === DISALLOWED_INTENTS_CLOSE_CODE || /disallowed intents/i.test(message);
}

export interface IntentLoginResult<C> {
  client: C;
  /** What the running gateway requested. */
  plan: IntentPlan;
  /** Privileged intents that were wanted but refused; the gateway runs without them. */
  missing: PrivilegedIntentName[];
}

export interface IntentLoginOptions<C extends IntentGateway> {
  plan: IntentPlan;
  /** A fresh client for these intents (a refused client is destroyed and cannot log in again). */
  create(intents: GatewayIntentBits[]): C;
  /** Logs in and waits for ready; `refused()` turns true as soon as Discord closes with 4014. */
  login(client: C, refused: () => boolean): Promise<void>;
  log(message: string): void;
}

/**
 * Logs in with the planned intents. On "Disallowed intents" with privileged intents requested, destroys
 * that client and logs in once more without them. Any other failure (or a refusal without privileged
 * intents) is rethrown unchanged.
 */
export async function loginWithIntentFallback<C extends IntentGateway>(options: IntentLoginOptions<C>): Promise<IntentLoginResult<C>> {
  const attempt = async (plan: IntentPlan): Promise<C> => {
    const client = options.create(plan.intents);
    let refused = false;
    const onDisconnect = (event: { code?: number } | undefined) => { if (event?.code === DISALLOWED_INTENTS_CLOSE_CODE) refused = true; };
    const onShardError = (error: unknown) => { if (isDisallowedIntentsError(error)) refused = true; };
    client.on('shardDisconnect', onDisconnect);
    client.on('shardError', onShardError);
    try {
      await options.login(client, () => refused);
      if (refused) throw Object.assign(new Error('Used disallowed intents'), { code: DISALLOWED_INTENTS_CLOSE_CODE });
      return client;
    } catch (error) {
      try { await client.destroy(); } catch { /* Already destroyed by discord.js. */ }
      throw refused ? Object.assign(new Error('Used disallowed intents'), { code: DISALLOWED_INTENTS_CLOSE_CODE }) : error;
    } finally {
      client.off('shardDisconnect', onDisconnect);
      client.off('shardError', onShardError);
    }
  };
  try {
    return { client: await attempt(options.plan), plan: options.plan, missing: [] };
  } catch (error) {
    if (!isDisallowedIntentsError(error) || options.plan.privileged.length === 0) throw error;
    const missing = [...options.plan.privileged];
    options.log(`Discord refused the privileged intents (${missing.join(', ')}). Starting without them; turn them on in the Developer Portal and restart.`);
    const fallback = withoutPrivileged(options.plan);
    return { client: await attempt(fallback), plan: fallback, missing };
  }
}
