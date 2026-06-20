/**
 * CRM tables migration — accounts + contacts
 * Run: node migrate-crm.cjs
 */
const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.resolve(__dirname, "sqlite.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    type TEXT NOT NULL DEFAULT 'client',
    website TEXT DEFAULT '',
    description TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    address TEXT DEFAULT '',
    city TEXT DEFAULT '',
    state TEXT DEFAULT '',
    country TEXT DEFAULT '',
    organization_id INTEGER REFERENCES organizations(id),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL DEFAULT '',
    email TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    job_title TEXT DEFAULT '',
    department TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    linkedin TEXT DEFAULT '',
    organization_id INTEGER REFERENCES organizations(id),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

console.log("✅ CRM tables (accounts, contacts) ready.");
db.close();
