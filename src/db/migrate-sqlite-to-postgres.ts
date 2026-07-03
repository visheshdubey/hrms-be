// One-off migration tool. Install locally first: npm install -D better-sqlite3 @types/better-sqlite3
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import pg from 'pg';

const SQLITE_PATH = path.resolve('sqlite.db');
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

if (!fs.existsSync(SQLITE_PATH)) {
  throw new Error(`SQLite database not found at ${SQLITE_PATH}`);
}

/** Insert order respects foreign keys (parents before children). */
const TABLE_ORDER = [
  'organizations',
  'users',
  'saved_reports',
  'accounts',
  'tags',
  'candidate_groups',
  'org_settings',
  'roles_permissions',
  'integrations',
  'jobs',
  'candidates',
  'contacts',
  'applications',
  'application_stage_history',
  'submissions',
  'interviews',
  'calendar_events',
  'notifications',
  'employees',
  'onboarding_workflows',
  'tasks',
  'campaigns',
  'job_stages',
  'candidate_tags',
  'application_tags',
  'candidate_group_members',
  'job_shortlists',
] as const;

const TABLES_WITH_SERIAL_ID = new Set([
  'organizations',
  'users',
  'saved_reports',
  'accounts',
  'tags',
  'candidate_groups',
  'org_settings',
  'roles_permissions',
  'integrations',
  'jobs',
  'candidates',
  'contacts',
  'applications',
  'application_stage_history',
  'submissions',
  'interviews',
  'calendar_events',
  'notifications',
  'employees',
  'onboarding_workflows',
  'tasks',
  'campaigns',
  'job_stages',
  'job_shortlists',
]);

function sqliteColumns(sqlite: Database.Database, table: string): string[] {
  return (sqlite.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map(
    (column) => column.name,
  );
}

async function postgresColumns(client: pg.Client, table: string): Promise<string[]> {
  const { rows } = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((row) => row.column_name);
}

async function truncateAll(client: pg.Client): Promise<void> {
  const tables = TABLE_ORDER.slice().reverse().join(', ');
  await client.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
}

async function insertBatch(
  client: pg.Client,
  table: string,
  columns: string[],
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return;

  const quoted = columns.map((column) => `"${column}"`).join(', ');
  const chunkSize = 100;

  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const values: unknown[] = [];
    const tuples = chunk
      .map((row, rowIndex) => {
        const placeholders = columns.map((column, columnIndex) => {
          values.push(row[column] ?? null);
          return `$${rowIndex * columns.length + columnIndex + 1}`;
        });
        return `(${placeholders.join(', ')})`;
      })
      .join(', ');

    await client.query(`INSERT INTO "${table}" (${quoted}) VALUES ${tuples}`, values);
  }
}

async function resetSerialSequence(client: pg.Client, table: string): Promise<void> {
  await client.query(`
    SELECT setval(
      pg_get_serial_sequence($1, 'id'),
      COALESCE((SELECT MAX(id) FROM "${table}"), 1),
      (SELECT COUNT(*) > 0 FROM "${table}")
    )
  `, [table]);
}

async function migrate(): Promise<void> {
  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  const client = new pg.Client({ connectionString });
  await client.connect();

  console.log('🗄️  Migrating SQLite → PostgreSQL');
  console.log(`   Source: ${SQLITE_PATH}`);

  await truncateAll(client);
  console.log('   Cleared PostgreSQL tables');

  let totalRows = 0;

  for (const table of TABLE_ORDER) {
    const sqliteTableExists = sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(table);

    if (!sqliteTableExists) {
      console.log(`   ↷ ${table} (not in SQLite, skipped)`);
      continue;
    }

    const sqliteCols = sqliteColumns(sqlite, table);
    const pgCols = await postgresColumns(client, table);
    const columns = sqliteCols.filter((column) => pgCols.includes(column));

    if (columns.length === 0) {
      console.log(`   ↷ ${table} (no matching columns, skipped)`);
      continue;
    }

    const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[];
    await insertBatch(client, table, columns, rows);

    if (TABLES_WITH_SERIAL_ID.has(table)) {
      await resetSerialSequence(client, table);
    }

    totalRows += rows.length;
    console.log(`   ✓ ${table}: ${rows.length} rows`);
  }

  sqlite.close();
  await client.end();

  console.log(`✅ Migration complete — ${totalRows} rows copied`);
  console.log('   Sign in again in the browser if you still see API errors.');
}

migrate().catch((error) => {
  console.error('Migration failed:', error);
  process.exit(1);
});
