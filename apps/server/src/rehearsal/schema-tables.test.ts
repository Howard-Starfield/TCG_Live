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
