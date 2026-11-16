// Exact public-schema table lists accepted by the guarded setup commands. Dependency-free so every
// setup module (rehearsal, directory, evidence, admin tools) can share it without import cycles.

export const TABLES_V1 = ['tcg_rehearsal_audit', 'tcg_rehearsal_events', 'tcg_rehearsal_meta'] as const;
export const TABLES_V2 = [...TABLES_V1, 'tcg_rehearsal_sessions'] as const;
export const DIRECTORY_TABLES = ['tcg_tournament_directory'] as const;
export const TABLES_V2_DIRECTORY = [...TABLES_V2, ...DIRECTORY_TABLES] as const;
/** Migration 012. bigserial columns add their sequences, which the relkind 'S' guard query also lists. */
export const EVIDENCE_TABLES = ['tcg_evidence', 'tcg_moderation_flags', 'tcg_moderation_flags_id_seq',
  'tcg_moderation_settings', 'tcg_ops_audit', 'tcg_ops_audit_id_seq'] as const;
export const TABLES_V2_DIRECTORY_EVIDENCE = [...TABLES_V2_DIRECTORY, ...EVIDENCE_TABLES] as const;
/** Migration 013 (admin tools). Includes the bigserial sequences of cases, notes, member events and the message log. */
export const ADMIN_TOOLS_TABLES = ['tcg_admin_counters', 'tcg_admin_tools_settings', 'tcg_announcements', 'tcg_bulk_role_jobs',
  'tcg_button_role_panels', 'tcg_member_events', 'tcg_member_events_id_seq', 'tcg_message_log', 'tcg_message_log_id_seq',
  'tcg_message_store', 'tcg_mod_cases', 'tcg_mod_cases_id_seq', 'tcg_mod_notes', 'tcg_mod_notes_id_seq',
  'tcg_sticky_messages', 'tcg_ticket_messages', 'tcg_tickets'] as const;
export const TABLES_V2_DIRECTORY_EVIDENCE_ADMIN_TOOLS = [...TABLES_V2_DIRECTORY_EVIDENCE, ...ADMIN_TOOLS_TABLES] as const;
/** Migration 014 (LFG), applied by setupAdminToolsSchema after 013. uuid keys, so no sequences. */
export const LFG_TABLES = ['tcg_lfg_players', 'tcg_lfg_posts', 'tcg_lfg_settings'] as const;
export const TABLES_V2_DIRECTORY_EVIDENCE_ADMIN_TOOLS_LFG = [...TABLES_V2_DIRECTORY_EVIDENCE_ADMIN_TOOLS, ...LFG_TABLES] as const;

/** 013 alone or 013 + 014: every later guard treats both as the admin tools shape. */
export function isAdminToolsShape(shape: string): boolean {
  return shape === 'v2_directory_evidence_admin_tools' || shape === 'v2_directory_evidence_admin_tools_lfg';
}

/** The pg_class query every guard uses: tables, views, sequences and foreign tables in public. */
export const PUBLIC_RELATIONS_SQL =
  "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f') ORDER BY c.relname";

export type PublicSchemaShape = 'empty' | 'v1' | 'v2' | 'v2_directory' | 'v2_directory_evidence' | 'v2_directory_evidence_admin_tools'
  | 'v2_directory_evidence_admin_tools_lfg'
  | 'unexpected';

/** Order-insensitive exact comparison, so database collation cannot change the answer. */
export function sameTables(names: readonly string[], expected: readonly string[]): boolean {
  if (names.length !== expected.length) return false;
  const left = [...names].sort();
  const right = [...expected].sort();
  return left.every((name, index) => name === right[index]);
}

/**
 * Migration 015's table. It is additive and optional: a database with it and one without it (015 not run yet) have the
 * same shape, so every guard ignores it. Only counted when tcg_evidence exists, so a stray table cannot pass for 012.
 */
export const EVIDENCE_REPLY_TABLES = ['tcg_evidence_replies'] as const;

/**
 * Migration 017's tables (match rooms and their transcripts). Optional like 015's: applied by setupAdminToolsSchema after 016,
 * and every guard sees the same shape with or without them.
 */
export const MATCH_ROOM_TABLES = ['tcg_match_room_categories', 'tcg_match_room_settings', 'tcg_match_room_transcripts',
  'tcg_match_rooms'] as const;
/** Tables a guard ignores (when tcg_evidence exists) because their migration may or may not have run. */
export const OPTIONAL_TABLES: readonly string[] = [...EVIDENCE_REPLY_TABLES, ...MATCH_ROOM_TABLES];

export function classifyPublicSchema(allNames: readonly string[]): PublicSchemaShape {
  const names = allNames.includes('tcg_evidence') ? allNames.filter(name => !OPTIONAL_TABLES.includes(name)) : allNames;
  if (names.length === 0) return 'empty';
  if (sameTables(names, TABLES_V1)) return 'v1';
  if (sameTables(names, TABLES_V2)) return 'v2';
  if (sameTables(names, TABLES_V2_DIRECTORY)) return 'v2_directory';
  if (sameTables(names, TABLES_V2_DIRECTORY_EVIDENCE)) return 'v2_directory_evidence';
  if (sameTables(names, TABLES_V2_DIRECTORY_EVIDENCE_ADMIN_TOOLS)) return 'v2_directory_evidence_admin_tools';
  if (sameTables(names, TABLES_V2_DIRECTORY_EVIDENCE_ADMIN_TOOLS_LFG)) return 'v2_directory_evidence_admin_tools_lfg';
  return 'unexpected';
}

/** setupRehearsalSchema: create on an empty schema, accept a known shape with its marker, refuse anything else. */
export function rehearsalSetupDecision(names: readonly string[], marker: string | null):
  'create' | 'already_ready' | 'refuse_schema' | 'refuse_version' {
  const shape = classifyPublicSchema(names);
  if (shape === 'empty') return 'create';
  if (shape === 'unexpected') return 'refuse_schema';
  if (marker === null) return 'refuse_version';
  return (shape === 'v1' ? marker === '1' : marker === '2') ? 'already_ready' : 'refuse_version';
}

/** setupPrivateDiscordSchema: upgrade v1 to v2 once; later additive shapes are already ready. */
export function privateDiscordSetupDecision(names: readonly string[], marker: string | null):
  'upgrade' | 'already_ready' | 'refuse' {
  const shape = classifyPublicSchema(names);
  if ((shape === 'v2' || shape === 'v2_directory' || shape === 'v2_directory_evidence' ||
       isAdminToolsShape(shape)) && marker === '2') return 'already_ready';
  return shape === 'v1' && marker === '1' ? 'upgrade' : 'refuse';
}

/** setupTournamentDirectory: v2 gets the full directory chain; a directory (with or without later additions) reapplies 004+. */
export function directorySetupDecision(names: readonly string[]): 'create' | 'already_ready' | 'refuse' {
  const shape = classifyPublicSchema(names);
  if (shape === 'v2') return 'create';
  return shape === 'v2_directory' || shape === 'v2_directory_evidence' || isAdminToolsShape(shape)
    ? 'already_ready' : 'refuse';
}

/** setupEvidenceSchema: needs the directory first; reapplying idempotent 012 on the evidence shape is safe. */
export function evidenceSetupDecision(names: readonly string[]): 'create' | 'already_ready' | 'refuse' {
  const shape = classifyPublicSchema(names);
  if (shape === 'v2_directory') return 'create';
  return shape === 'v2_directory_evidence' || isAdminToolsShape(shape) ? 'already_ready' : 'refuse';
}

/** setupAdminToolsSchema: needs evidence (012) first; reapplying idempotent 013 on its own shape is safe. */
export function adminToolsSetupDecision(names: readonly string[]): 'create' | 'already_ready' | 'refuse' {
  const shape = classifyPublicSchema(names);
  if (shape === 'v2_directory_evidence') return 'create';
  return isAdminToolsShape(shape) ? 'already_ready' : 'refuse';
}
