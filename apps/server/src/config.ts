export const CONFIG_ERROR = 'Invalid configuration: use a single loopback PostgreSQL URL with a database name and no query or fragment.';

export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export interface AppConfig {
  port: number;
  database: DatabaseConfig | null;
}

export function parseDatabaseUrl(raw: string | undefined): DatabaseConfig | null {
  if (raw === undefined || raw.trim() === '') return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
        !['localhost', '127.0.0.1', '[::1]'].includes(host) ||
        !url.username || !url.password || !url.pathname || url.pathname === '/' ||
        raw.includes('?') || raw.includes('#') || !url.port ||
        url.pathname.slice(1).includes('/') ||
        raw.includes(',') || raw.includes('\\')) throw new Error('invalid');
    const port = Number(url.port);
    const database = decodeURIComponent(url.pathname.slice(1));
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (!Number.isInteger(port) || port < 1 || port > 65535 ||
        !database || !user || !password ||
        [database, user, password].some(value => /[\u0000-\u001f\u007f]/.test(value))) throw new Error('invalid');
    return { host: host === '[::1]' ? '::1' : host, port, database, user, password };
  } catch {
    throw new Error(CONFIG_ERROR);
  }
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rawPort = env.PORT === undefined ? '3000' : env.PORT;
  if (!/^[1-9]\d{0,4}$/.test(rawPort)) throw new Error('Invalid configuration: PORT must be an integer from 1 to 65535.');
  const port = Number(rawPort);
  if (port > 65535) throw new Error('Invalid configuration: PORT must be an integer from 1 to 65535.');
  return { port, database: parseDatabaseUrl(env.DATABASE_URL) };
}
