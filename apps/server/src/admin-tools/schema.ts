import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { requireEvidenceSchema } from '../evidence/schema.js';
import { RuleError } from '../rehearsal/domain.js';
import { ADMIN_TOOLS_TABLES, adminToolsSetupDecision, classifyPublicSchema, LFG_TABLES, PUBLIC_RELATIONS_SQL } from '../rehearsal/schema-tables.js';
import { transaction, withClient } from '../rehearsal/store.js';

/** A RuleError, so the shared isDatabaseUnavailable() maps it to a 503 with this setup hint. */
export class AdminToolsSchemaUnavailableError extends RuleError {}

export const ADMIN_TOOLS_SETUP_HINT = 'Admin tools storage is not set up. Restart with npm start or run npm run db:admin-tools-setup.';

export const ADMIN_TOOLS_MIGRATION = new URL('../../../../database/migrations/013_admin_tools.sql', import.meta.url);
/** Migration 014 (LFG), applied right after 013 by setupAdminToolsSchema. */
export const LFG_MIGRATION = new URL('../../../../database/migrations/014_lfg.sql', import.meta.url);

/** Tables only (sequences are implied by their bigserial owners). */
const REQUIRED = ADMIN_TOOLS_TABLES.filter(name => !name.endsWith('_seq'));

/** Every admin-tools query checks this first (it also checks 012, which the ops audit needs). */
export async function requireAdminToolsSchema(client: pg.Client): Promise<void> {
  await requireEvidenceSchema(client);
  const result = await client.query<{ missing: number }>(
    `SELECT count(*)::int AS missing FROM unnest($1::text[]) AS name WHERE to_regclass('public.' || name) IS NULL`, [REQUIRED]);
  if ((result.rows[0]?.missing ?? 1) !== 0) throw new AdminToolsSchemaUnavailableError(ADMIN_TOOLS_SETUP_HINT);
}

/** LFG queries check this first (013 tables plus 014). */
export async function requireLfgSchema(client: pg.Client): Promise<void> {
  await requireAdminToolsSchema(client);
  const result = await client.query<{ missing: number }>(
    `SELECT count(*)::int AS missing FROM unnest($1::text[]) AS name WHERE to_regclass('public.' || name) IS NULL`, [[...LFG_TABLES]]);
  if ((result.rows[0]?.missing ?? 1) !== 0) throw new AdminToolsSchemaUnavailableError(ADMIN_TOOLS_SETUP_HINT);
}

/**
 * Explicit additive migrations 013 and 014 (LFG), run after setupEvidenceSchema(). Uses its own advisory lock and the
 * exact-table-list guard: it runs only on the known evidence shape (or reapplies on its own shape).
 */
export async function setupAdminToolsSchema(): Promise<'created' | 'already_ready'> {
  return withClient(client => transaction(client, async () => {
    await requireEvidenceSchema(client);
    await client.query("SELECT pg_advisory_xact_lock(hashtext('tcg_admin_tools_schema'))");
    const objects = await client.query<{ relname: string }>(PUBLIC_RELATIONS_SQL);
    const decision = adminToolsSetupDecision(objects.rows.map(row => row.relname));
    if (decision === 'refuse') throw new AdminToolsSchemaUnavailableError('Admin tools setup refused: unexpected public schema.');
    await client.query(await readFile(ADMIN_TOOLS_MIGRATION, 'utf8'));
    const hadLfg = classifyPublicSchema(objects.rows.map(row => row.relname)) === 'v2_directory_evidence_admin_tools_lfg';
    await client.query(await readFile(LFG_MIGRATION, 'utf8'));
    return decision === 'already_ready' && hadLfg ? 'already_ready' : 'created';
  }));
}

export type AdminCounterName = 'case' | 'ticket';

/**
 * Allocates the next per-guild number (case or ticket) inside the caller's transaction: the counter row
 * stays locked until commit, so numbers are gap-free and never reused even under concurrent requests.
 */
export async function allocateAdminCounter(client: pg.Client, guildId: string, name: AdminCounterName): Promise<number> {
  const result = await client.query<{ last_value: number }>(
    `INSERT INTO public.tcg_admin_counters (guild_id, name, last_value) VALUES ($1, $2, 1)
     ON CONFLICT (guild_id, name) DO UPDATE SET last_value = public.tcg_admin_counters.last_value + 1
     RETURNING last_value`, [guildId, name]);
  return result.rows[0]!.last_value;
}

/** In-memory twin of allocateAdminCounter for memory stores (tests, demo). */
export class MemoryAdminCounters {
  private readonly values = new Map<string, number>();
  next(guildId: string, name: AdminCounterName): number {
    const key = `${guildId}:${name}`;
    const value = (this.values.get(key) ?? 0) + 1;
    this.values.set(key, value);
    return value;
  }
}
