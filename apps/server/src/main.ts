import { readConfig } from './config.js';
import { startServer } from './server.js';

async function main(): Promise<void> {
  try {
    const config = readConfig();
    const running = await startServer(config);
    process.stdout.write(`TCG Live health server listening on 127.0.0.1:${running.port}\n`);
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      void running.stop().then(() => {
        process.stdout.write('TCG Live health server stopped\n');
      });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('SIGBREAK', shutdown);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Startup failed.'}\n`);
    process.exitCode = 1;
  }
}

void main();
