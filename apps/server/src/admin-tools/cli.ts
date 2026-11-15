import { setupAdminToolsSchema } from './schema.js';

if (process.argv[2] !== 'setup' || process.argv.length !== 3) {
  process.stderr.write('Usage: node dist/admin-tools/cli.js setup\n');
  process.exitCode = 2;
} else {
  setupAdminToolsSchema().then(result => {
    process.stdout.write(`Admin tools schema: ${result}.\n`);
  }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Admin tools setup failed.'}\n`);
    process.exitCode = 1;
  });
}
