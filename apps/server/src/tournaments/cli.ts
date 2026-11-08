import { setupTournamentDirectory } from './directory.js';

if (process.argv[2] !== 'setup' || process.argv.length !== 3) {
  process.stderr.write('Usage: node dist/tournaments/cli.js setup\n');
  process.exitCode = 2;
} else {
  setupTournamentDirectory().then(result => {
    process.stdout.write(`Tournament directory schema: ${result}.\n`);
  }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Tournament directory setup failed.'}\n`);
    process.exitCode = 1;
  });
}
