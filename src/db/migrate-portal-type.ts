import Database from 'better-sqlite3';
import path from 'path';

const db = new Database(path.resolve('sqlite.db'));

function columnNames(table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (column) => column.name,
  );
}

const userColumns = columnNames('users');

if (userColumns.includes('org_id') && !userColumns.includes('organization_id')) {
  db.exec(`ALTER TABLE users RENAME COLUMN org_id TO organization_id`);
  console.log('Renamed users.org_id → organization_id');
}

const refreshedUserColumns = columnNames('users');

if (!refreshedUserColumns.includes('portal_type')) {
  db.exec(`ALTER TABLE users ADD COLUMN portal_type text`);
  db.exec(`UPDATE users SET portal_type = 'recruiter' WHERE portal_type IS NULL`);
  console.log('Added users.portal_type column');
}

db.close();
console.log('Legacy schema sync complete');
