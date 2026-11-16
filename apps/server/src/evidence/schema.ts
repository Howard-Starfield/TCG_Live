import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { RuleError } from '../rehearsal/domain.js';
import { evidenceSetupDecision, PUBLIC_RELATIONS_SQL } from '../rehearsal/schema-tables.js';
import { transaction, withClient } from '../rehearsal/store.js';
import { requireDirectorySchema } from '../tournaments/directory.js';

/** A RuleError, so the shared isDatabaseUnavailable() maps it to a 503 with this setup hint. */
export class EvidenceSchemaUnavailableError extends RuleError {}

export const EVIDENCE_SETUP_HINT = 'Evidence and moderation storage is not set up. Restart with npm start or run npm run db:evidence-setup.';

/** Every evidence, moderation and ops-audit query checks this first, like requireDirectorySchema. */
export async function requireEvidenceSchema(client: pg.Client): Promise<void> {
  await requireDirectorySchema(client);
  const result = await client.query<{ evidence: string | null; audit: string | null; settings: string | null; flags: string | null }>(
    `SELECT to_regclass('public.tcg_evidence')::text AS evidence, to_regclass('public.tcg_ops_audit')::text AS audit,
       to_regclass('public.tcg_moderation_settings')::text AS settings, to_regclass('public.tcg_moderation_flags')::text AS flags`);
  const row = result.rows[0];
  if (!row?.evidence || !row.audit || !row.settings || !row.flags) throw new EvidenceSchemaUnavailableError(EVIDENCE_SETUP_HINT);
}

/**
 * Text notes and replies need migration 015 too (a CHECK that allows kind 'note', and the replies table). Checked by the
 * code that writes them, so evidence from before 015 stays readable until setup has run.
 */
export async function requireEvidenceRepliesSchema(client: pg.Client): Promise<void> {
  await requireEvidenceSchema(client);
  const result = await client.query<{ replies: string | null }>("SELECT to_regclass('public.tcg_evidence_replies')::text AS replies");
  if (!result.rows[0]?.replies) throw new EvidenceSchemaUnavailableError(EVIDENCE_SETUP_HINT);
}

/**
 * Explicit additive migrations 012 and 015, run after setupTournamentDirectory(). Uses its own advisory lock and
 * the exact-table-list guard: it runs only on the known directory shape (or reapplies on its own shape).
 */
export async function setupEvidenceSchema(): Promise<'created' | 'already_ready'> {
  return withClient(client => transaction(client, async () => {
    await requireDirectorySchema(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('tcg_evidence_schema'))");
    const objects = await client.query<{ relname: string }>(PUBLIC_RELATIONS_SQL);
    const decision = evidenceSetupDecision(objects.rows.map(row => row.relname));
    if (decision === 'refuse') throw new EvidenceSchemaUnavailableError('Evidence setup refused: unexpected public schema.');
    await client.query(await readFile(new URL('../../../../database/migrations/012_evidence_and_moderation.sql', import.meta.url), 'utf8'));
    await client.query(await readFile(new URL('../../../../database/migrations/015_evidence_notes_and_replies.sql', import.meta.url), 'utf8'));
    return decision === 'already_ready' ? 'already_ready' : 'created';
  }));
}
