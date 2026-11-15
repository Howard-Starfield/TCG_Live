// Per-player recording opt-out, persisted in the moderation settings JSON (recording.optOutUserIds), so
// no migration or schema-guard change is needed. Opted-out players are never subscribed, recorded or
// loudness-checked. Every change is audited (voice.recording.opt_out) besides the settings audit.
import { MODERATION_LIMITS, type RecordingOptOutListDto } from '@tcg-live/core';
import type { OpsActor, OpsAuditInput } from '../ops/audit.js';
import { OpsConflictError, OpsInputError } from '../ops/errors.js';
import { SNOWFLAKE } from '../ops/http.js';
import { ModerationVersionConflictError, type ModerationSettingsStore } from '../moderation/settings.js';

export interface RecordingOptOutDeps {
  settings: Pick<ModerationSettingsStore, 'get' | 'put'>;
  audit(input: OpsAuditInput): Promise<unknown>;
  guildId(): string | null;
  /** After a change is saved (the runtime reloads its settings from here). */
  onChanged?(): void;
}

export interface RecordingOptOutResult extends RecordingOptOutListDto { changed: boolean }

/**
 * setRecordingOptOut(userId, optedOut, actor): adds or removes one player. Retries a concurrent settings
 * save (version conflict) a few times. The Discord command passes the player as actor
 * ({ kind: 'player', id: userId }); the dashboard passes the local admin.
 */
export function recordingOptOuts(deps: RecordingOptOutDeps) {
  const guild = () => {
    const id = deps.guildId();
    if (!id) throw new OpsConflictError('Finish Discord setup before changing recording opt-outs.');
    return id;
  };
  async function list(): Promise<RecordingOptOutListDto> {
    const settings = await deps.settings.get(guild());
    return { userIds: [...(settings.recording.optOutUserIds ?? [])], version: settings.version };
  }
  async function setRecordingOptOut(userId: string, optedOut: boolean, actor: OpsActor): Promise<RecordingOptOutResult> {
    if (typeof userId !== 'string' || !SNOWFLAKE.test(userId)) throw new OpsInputError('userId must be a Discord user ID.');
    if (typeof optedOut !== 'boolean') throw new OpsInputError('optedOut must be true or false.');
    const guildId = guild();
    for (let attempt = 0; ; attempt += 1) {
      const current = await deps.settings.get(guildId);
      const ids = new Set(current.recording.optOutUserIds ?? []);
      if (ids.has(userId) === optedOut) return { userIds: [...ids], version: current.version, changed: false };
      if (optedOut) {
        if (ids.size >= MODERATION_LIMITS.recordingOptOuts)
          throw new OpsConflictError(`At most ${MODERATION_LIMITS.recordingOptOuts} players can opt out of recording.`);
        ids.add(userId);
      } else ids.delete(userId);
      const { guildId: _guild, version, updatedAtMs: _updated, ...body } = current;
      try {
        const saved = await deps.settings.put(guildId, version, { ...body, recording: { ...body.recording, optOutUserIds: [...ids] } }, actor);
        await deps.audit({ kind: 'voice.recording.opt_out', actor, guildId, payload: { userId, optedOut } }).catch(() => {});
        try { deps.onChanged?.(); } catch { /* Listeners never fail a change. */ }
        return { userIds: [...(saved.recording.optOutUserIds ?? [])], version: saved.version, changed: true };
      } catch (error) {
        if (error instanceof ModerationVersionConflictError && attempt < 4) continue;
        throw error;
      }
    }
  }
  return { list, setRecordingOptOut };
}
