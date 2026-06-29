import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

const migrationsDir = path.resolve('drizzle');

async function resetDatabase() {
  const client = new pg.Client({ connectionString });
  await client.connect();

  await client.query('DROP SCHEMA IF EXISTS public CASCADE');
  await client.query('CREATE SCHEMA public');
  await client.query('GRANT ALL ON SCHEMA public TO public');

  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of migrationFiles) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    const statements = sql
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statement of statements) {
      await client.query(statement);
    }
    console.log(`Applied ${file}`);
  }

  await client.end();
  console.log('PostgreSQL database reset complete');
}

resetDatabase().catch((error) => {
  console.error(error);
  process.exit(1);
});
