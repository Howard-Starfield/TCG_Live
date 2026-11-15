// Local switches for the guided start (npm start): "Allow dashboard actions" and voice monitoring.
// Saved in the setup profile (data/discord-setup.json). Precedence, per setting:
//   - `1` in .env or the shell (TCG_ADMIN_COMMANDS / TCG_DISCORD_VOICE) forces it on, whatever the switch says;
//   - `0`, blank or unset defers to the saved switch. Every guided install copied `=0` from .env.example, so a
//     `0` cannot be told apart from "never chosen"; to keep the dashboard read-only, turn the switch off.
// Direct commands (npm run discord:run and friends) never read the switches: there the .env flags alone decide.
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { LocalSettingsDto, LocalSettingsPatchDto } from '@tcg-live/core';
import { readJsonBody, strictObject } from '../admin/http/body.js';
import { HttpError, sendJson } from '../admin/http/respond.js';
import type { OpsAuditStore } from '../ops/audit.js';
import type { OpsRoute } from '../ops/http.js';
import { DEFAULT_SWITCHES, SetupProfileStore, type LocalSwitches } from './profile.js';

/** True only for an explicit `1`; `0`, blank and unset leave the decision to the saved switch. */
export function envForcesOn(env: NodeJS.ProcessEnv, name: string): boolean {
  return env[name]?.trim() === '1';
}

/** Blank, unset or `0`: values the launcher may replace with the saved voice switch. */
function voiceDeferred(raw: string | undefined): boolean {
  return raw === undefined || raw.trim() === '' || raw.trim() === '0';
}

export const LOCAL_SETTINGS_UNREADABLE = 'Local settings could not be saved: review data/discord-setup.json locally.';

export interface LocalSettingsOptions {
  store?: SetupProfileStore;
  env?: NodeJS.ProcessEnv;
  /** Local append-only change log; defaults to data/local-settings-audit.jsonl beside the profile. */
  auditFile?: string;
  now?: () => number;
}

export class LocalSettings {
  private saved: LocalSwitches;
  private voiceRunning: boolean | null = null;
  private audit: OpsAuditStore | null = null;
  private readonly forced: { dashboard: boolean; voice: boolean };
  private readonly store: SetupProfileStore;
  private readonly auditFile: string;
  private readonly now: () => number;

  private constructor(saved: LocalSwitches, options: LocalSettingsOptions) {
    const env = options.env ?? process.env;
    this.saved = saved;
    this.store = options.store ?? new SetupProfileStore();
    this.forced = { dashboard: envForcesOn(env, 'TCG_ADMIN_COMMANDS'), voice: envForcesOn(env, 'TCG_DISCORD_VOICE') };
    this.auditFile = options.auditFile ?? path.join(path.dirname(this.store.file), 'local-settings-audit.jsonl');
    this.now = options.now ?? Date.now;
  }

  /** Reads the switches once (call after .env is loaded); an unreadable profile counts as the defaults. */
  static async load(options: LocalSettingsOptions = {}): Promise<LocalSettings> {
    const store = options.store ?? new SetupProfileStore();
    let saved: LocalSwitches = { ...DEFAULT_SWITCHES };
    try { saved = (await store.read()).settings ?? saved; } catch { /* The setup page reports the unreadable profile. */ }
    return new LocalSettings(saved, { ...options, store });
  }

  /** What every session gets now; read on each request, so a change applies without signing in again. */
  dashboardActionsEnabled(): boolean {
    return this.forced.dashboard || this.saved.dashboardActions;
  }

  /**
   * Right before the Discord runtime starts: voice monitoring reads TCG_DISCORD_VOICE once at start, so the
   * saved switch is written there unless .env already forces it on (or holds an invalid value, which the voice
   * feature reports). Returns what the bot will use.
   */
  applyVoice(env: NodeJS.ProcessEnv = process.env): boolean {
    if (this.forced.voice) { this.voiceRunning = true; return true; }
    if (!voiceDeferred(env.TCG_DISCORD_VOICE)) { this.voiceRunning = false; return false; }
    env.TCG_DISCORD_VOICE = this.saved.voiceMonitoring ? '1' : '0';
    this.voiceRunning = this.saved.voiceMonitoring;
    return this.voiceRunning;
  }

  /** Ops audit for setting changes once the database-backed runtime is up; the local log is always written. */
  attachAudit(audit: OpsAuditStore | null | undefined): void {
    this.audit = audit ?? null;
  }

  describe(): LocalSettingsDto {
    const voiceWanted = this.forced.voice || this.saved.voiceMonitoring;
    return {
      dashboardActions: { enabled: this.dashboardActionsEnabled(), saved: this.saved.dashboardActions,
        forcedByEnv: this.forced.dashboard },
      voiceMonitoring: { saved: this.saved.voiceMonitoring, running: this.voiceRunning, forcedByEnv: this.forced.voice,
        restartRequired: this.voiceRunning !== null && voiceWanted !== this.voiceRunning }
    };
  }

  /** Strict PUT body: at least one known boolean field. Throws HttpError 400. */
  static parsePatch(body: unknown): LocalSettingsPatchDto {
    const source = strictObject(body, ['dashboardActions', 'voiceMonitoring']);
    const patch: LocalSettingsPatchDto = {};
    for (const key of ['dashboardActions', 'voiceMonitoring'] as const) {
      if (!Object.hasOwn(source, key)) continue;
      if (typeof source[key] !== 'boolean') throw new HttpError(400, 'bad_request', `${key} must be true or false.`);
      patch[key] = source[key] as boolean;
    }
    if (!Object.keys(patch).length) throw new HttpError(400, 'bad_request', 'Change dashboardActions or voiceMonitoring.');
    return patch;
  }

  async update(patch: LocalSettingsPatchDto): Promise<LocalSettingsDto> {
    const before = { ...this.saved };
    let next: LocalSwitches;
    try { next = await this.store.updateSwitches(current => ({ ...current, ...patch })); }
    catch { throw new HttpError(503, 'unavailable', LOCAL_SETTINGS_UNREADABLE); }
    this.saved = next;
    const changes: Record<string, { from: boolean; to: boolean }> = {};
    for (const key of ['dashboardActions', 'voiceMonitoring'] as const)
      if (before[key] !== next[key]) changes[key] = { from: before[key], to: next[key] };
    if (Object.keys(changes).length) await this.record(changes);
    return this.describe();
  }

  private async record(changes: Record<string, { from: boolean; to: boolean }>): Promise<void> {
    const occurredAtMs = this.now();
    const payload = { changes, effective: { dashboardActions: this.dashboardActionsEnabled() },
      forcedByEnv: { ...this.forced } };
    // Best effort on both sinks: the switch is already saved, and a failed audit must not report a failed save.
    try {
      await mkdir(path.dirname(this.auditFile), { recursive: true });
      await appendFile(this.auditFile, JSON.stringify({ kind: 'local.settings', actor: 'local-admin', occurredAtMs, ...payload }) + '\n',
        { mode: 0o600 });
    } catch { /* The ops audit below may still record it. */ }
    try { await this.audit?.append({ kind: 'local.settings', actor: { kind: 'admin', id: 'local-admin' }, payload, occurredAtMs }); }
    catch { /* The local log has it. */ }
  }
}

/** GET/PUT /api/v1/settings/local. Any signed-in local session: the switch is how a read-only session turns actions on. */
export function localSettingsRoutes(settings: LocalSettings): OpsRoute[] {
  return [{ pattern: /^\/api\/v1\/settings\/local$/, methods: {
    GET: { access: 'session', run: async ({ response }) => sendJson(response, 200, settings.describe()) },
    PUT: { access: 'session', run: async ({ request, response }) =>
      sendJson(response, 200, await settings.update(LocalSettings.parsePatch(await readJsonBody(request)))) }
  } }];
}
