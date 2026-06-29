import 'dotenv/config';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not set');
}

async function syncLegacySchema() {
  const client = new pg.Client({ connectionString });
  await client.connect();

  const { rows: userColumns } = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`,
  );
  const names = userColumns.map((column) => column.column_name);

  if (names.includes('org_id') && !names.includes('organization_id')) {
    await client.query(`ALTER TABLE users RENAME COLUMN org_id TO organization_id`);
    console.log('Renamed users.org_id → organization_id');
  }

  const { rows: refreshed } = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`,
  );
  const refreshedNames = refreshed.map((column) => column.column_name);

  if (!refreshedNames.includes('portal_type')) {
    await client.query(`ALTER TABLE users ADD COLUMN portal_type text`);
    await client.query(`UPDATE users SET portal_type = 'recruiter' WHERE portal_type IS NULL`);
    console.log('Added users.portal_type column');
  }

  await client.end();
  console.log('Legacy schema sync complete');
}

syncLegacySchema().catch((error) => {
  console.error(error);
  process.exit(1);
});
