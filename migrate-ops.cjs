/**
 * Ops tables migration — tasks + campaigns
 * Run: node migrate-ops.cjs
 */
const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.resolve(__dirname, "sqlite.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_code TEXT NOT NULL,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    description TEXT DEFAULT '',
    priority TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'pending',
    due_date TEXT DEFAULT '',
    reminder_at TEXT DEFAULT '',
    assigned_to INTEGER REFERENCES users(id),
    candidate_id INTEGER REFERENCES candidates(id),
    job_id INTEGER REFERENCES jobs(id),
    organization_id INTEGER REFERENCES organizations(id),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'hotlist',
    status TEXT NOT NULL DEFAULT 'draft',
    subject TEXT DEFAULT '',
    body TEXT DEFAULT '',
    recipients_json TEXT DEFAULT '[]',
    recipient_count INTEGER NOT NULL DEFAULT 0,
    scheduled_at TEXT DEFAULT '',
    sent_at TEXT DEFAULT '',
    organization_id INTEGER REFERENCES organizations(id),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

console.log("✅ Ops tables (tasks, campaigns) ready.");
db.close();
