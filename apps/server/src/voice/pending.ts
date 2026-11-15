// Recovery source beyond the local journal: bot voice recordings still 'pending' in tcg_evidence. Read-only.
import { requireEvidenceSchema } from '../evidence/schema.js';
import { withClient } from '../rehearsal/store.js';
import type { PendingVoiceRow } from './recorder.js';

export function pgPendingVoiceRows(limit = 200): () => Promise<PendingVoiceRow[]> {
  return () => withClient(async client => {
    await requireEvidenceSchema(client);
    const result = await client.query<{ id: string; event_id: string; match_id: string | null; storage_path: string | null; created_at_ms: string }>(
      `SELECT id::text AS id, event_id::text AS event_id, match_id, storage_path, created_at_ms FROM public.tcg_evidence
       WHERE status = 'pending' AND kind = 'voice' AND source = 'bot' ORDER BY created_at_ms LIMIT $1`, [limit]);
    return result.rows.map(row => ({ id: row.id, eventId: row.event_id, matchId: row.match_id, storagePath: row.storage_path,
      createdAtMs: Number(row.created_at_ms) }));
  });
}
