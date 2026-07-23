import { spawnSync } from 'node:child_process';
import { configureSafeTestDatabase } from './test-environment.js';

const databaseUrl = configureSafeTestDatabase();
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this setup through npm');

const result = spawnSync(
  process.execPath,
  [npmCli, 'exec', 'drizzle-kit', 'push'],
  {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
