import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyPublicSchema, directorySetupDecision, EVIDENCE_TABLES, evidenceSetupDecision, privateDiscordSetupDecision,
  rehearsalSetupDecision, sameTables, TABLES_V1, TABLES_V2, TABLES_V2_DIRECTORY, TABLES_V2_DIRECTORY_EVIDENCE } from './schema-tables.js';

const withEvidence = [...TABLES_V2_DIRECTORY_EVIDENCE];
const shuffled = [...withEvidence].reverse();

test('the evidence shape is exactly the directory shape plus migration 012 tables and their sequences', () => {
  assert.deepEqual([...EVIDENCE_TABLES].sort(), ['tcg_evidence', 'tcg_moderation_flags', 'tcg_moderation_flags_id_seq',
    'tcg_moderation_settings', 'tcg_ops_audit', 'tcg_ops_audit_id_seq']);
  assert.equal(classifyPublicSchema([]), 'empty');
  assert.equal(classifyPublicSchema([...TABLES_V1]), 'v1');
  assert.equal(classifyPublicSchema([...TABLES_V2]), 'v2');
  assert.equal(classifyPublicSchema([...TABLES_V2_DIRECTORY]), 'v2_directory');
  assert.equal(classifyPublicSchema(withEvidence), 'v2_directory_evidence');
  // Collation cannot change the answer.
  assert.equal(classifyPublicSchema(shuffled), 'v2_directory_evidence');
  assert.equal(sameTables(['b', 'a'], ['a', 'b']), true);
  assert.equal(sameTables(['a', 'a'], ['a', 'b']), false);
});

test('partial, extra or foreign tables are unexpected, never accepted', () => {
  for (const names of [
    [...TABLES_V2_DIRECTORY, 'tcg_evidence'],                                  // half-applied 012
    withEvidence.filter(name => name !== 'tcg_ops_audit_id_seq'),               // missing sequence
    [...withEvidence, 'users'],                                                 // foreign table
    [...TABLES_V2, ...EVIDENCE_TABLES],                                         // evidence without the directory
    ['users']
  ]) assert.equal(classifyPublicSchema(names), 'unexpected', names.join(','));
});

test('rehearsal and private Discord guards accept both the old and the new table sets', () => {
  assert.equal(rehearsalSetupDecision([], null), 'create');
  assert.equal(rehearsalSetupDecision([...TABLES_V1], '1'), 'already_ready');
  assert.equal(rehearsalSetupDecision([...TABLES_V2], '2'), 'already_ready');
  assert.equal(rehearsalSetupDecision([...TABLES_V2_DIRECTORY], '2'), 'already_ready');
  assert.equal(rehearsalSetupDecision(withEvidence, '2'), 'already_ready');
  assert.equal(rehearsalSetupDecision(withEvidence, '1'), 'refuse_version');
  assert.equal(rehearsalSetupDecision([...TABLES_V1], '2'), 'refuse_version');
  assert.equal(rehearsalSetupDecision(withEvidence, null), 'refuse_version');
  assert.equal(rehearsalSetupDecision(['users'], '2'), 'refuse_schema');

  assert.equal(privateDiscordSetupDecision([...TABLES_V1], '1'), 'upgrade');
  assert.equal(privateDiscordSetupDecision([...TABLES_V2], '2'), 'already_ready');
  assert.equal(privateDiscordSetupDecision([...TABLES_V2_DIRECTORY], '2'), 'already_ready');
  assert.equal(privateDiscordSetupDecision(withEvidence, '2'), 'already_ready');
  assert.equal(privateDiscordSetupDecision(withEvidence, '1'), 'refuse');
  assert.equal(privateDiscordSetupDecision([...TABLES_V2_DIRECTORY, 'tcg_evidence'], '2'), 'refuse');
});

test('directory and evidence setup run in order and stay ready afterwards', () => {
  assert.equal(directorySetupDecision([...TABLES_V2]), 'create');
  assert.equal(directorySetupDecision([...TABLES_V2_DIRECTORY]), 'already_ready');
  assert.equal(directorySetupDecision(withEvidence), 'already_ready');
  assert.equal(directorySetupDecision([...TABLES_V1]), 'refuse');
  assert.equal(directorySetupDecision([...TABLES_V2_DIRECTORY, 'tcg_evidence']), 'refuse');

  assert.equal(evidenceSetupDecision([...TABLES_V2_DIRECTORY]), 'create');
  assert.equal(evidenceSetupDecision(withEvidence), 'already_ready');
  assert.equal(evidenceSetupDecision([...TABLES_V2]), 'refuse', 'the directory must exist first');
  assert.equal(evidenceSetupDecision([...TABLES_V2_DIRECTORY, 'tcg_evidence']), 'refuse');
  assert.equal(evidenceSetupDecision([]), 'refuse');
});

test('admin tools (013) shape is the evidence shape plus exactly its tables and sequences', async () => {
  const { ADMIN_TOOLS_TABLES, TABLES_V2_DIRECTORY_EVIDENCE_ADMIN_TOOLS, adminToolsSetupDecision } = await import('./schema-tables.js');
  const withAdmin = [...TABLES_V2_DIRECTORY_EVIDENCE_ADMIN_TOOLS];
  // bigserial columns: cases, notes, member events and the message log each add one sequence.
  assert.deepEqual(ADMIN_TOOLS_TABLES.filter(name => name.endsWith('_seq')).sort(),
    ['tcg_member_events_id_seq', 'tcg_message_log_id_seq', 'tcg_mod_cases_id_seq', 'tcg_mod_notes_id_seq']);
  assert.equal(new Set(withAdmin).size, withAdmin.length);
  assert.equal(classifyPublicSchema(withAdmin), 'v2_directory_evidence_admin_tools');
  assert.equal(classifyPublicSchema([...withAdmin].reverse()), 'v2_directory_evidence_admin_tools');

  // Every older guard keeps accepting the new shape, so the launcher's setup chain still runs on each start.
  assert.equal(rehearsalSetupDecision(withAdmin, '2'), 'already_ready');
  assert.equal(rehearsalSetupDecision(withAdmin, '1'), 'refuse_version');
  assert.equal(privateDiscordSetupDecision(withAdmin, '2'), 'already_ready');
  assert.equal(directorySetupDecision(withAdmin), 'already_ready');
  assert.equal(evidenceSetupDecision(withAdmin), 'already_ready');

  assert.equal(adminToolsSetupDecision(withEvidence), 'create');
  assert.equal(adminToolsSetupDecision(withAdmin), 'already_ready');
  assert.equal(adminToolsSetupDecision([...TABLES_V2_DIRECTORY]), 'refuse', 'evidence (012) must exist first');
  assert.equal(adminToolsSetupDecision([]), 'refuse');
  for (const names of [
    [...withEvidence, 'tcg_mod_cases'],                                             // half-applied 013
    withAdmin.filter(name => name !== 'tcg_mod_cases_id_seq'),                      // missing sequence
    [...withAdmin, 'users'],                                                        // foreign table
    [...TABLES_V2_DIRECTORY, ...ADMIN_TOOLS_TABLES]                                 // admin tools without evidence
  ]) {
    assert.equal(classifyPublicSchema(names), 'unexpected', names.join(','));
    assert.equal(adminToolsSetupDecision(names), 'refuse');
    assert.equal(evidenceSetupDecision(names), 'refuse');
    assert.equal(directorySetupDecision(names), 'refuse');
  }
});
