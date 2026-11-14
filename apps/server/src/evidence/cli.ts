import { setupEvidenceSchema } from './schema.js';

if (process.argv[2] !== 'setup' || process.argv.length !== 3) {
  process.stderr.write('Usage: node dist/evidence/cli.js setup\n');
  process.exitCode = 2;
} else {
  setupEvidenceSchema().then(result => {
    process.stdout.write(`Evidence and moderation schema: ${result}.\n`);
  }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Evidence setup failed.'}\n`);
    process.exitCode = 1;
  });
}
