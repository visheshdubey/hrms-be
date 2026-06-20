/**
 * Calendar events table migration
 * Run: node migrate-calendar.cjs
 */
const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.resolve(__dirname, "sqlite.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    color TEXT DEFAULT 'blue',
    event_type TEXT DEFAULT 'general',
    candidate_id INTEGER,
    candidate_name TEXT DEFAULT '',
    job_profile TEXT DEFAULT '',
    location TEXT DEFAULT '',
    description TEXT DEFAULT '',
    meeting_link TEXT DEFAULT '',
    is_all_day INTEGER DEFAULT 0,
    organization_id INTEGER REFERENCES organizations(id),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

console.log("✅ Calendar table (calendar_events) ready.");
