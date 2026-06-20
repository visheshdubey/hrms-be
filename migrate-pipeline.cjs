/**
 * Pipeline tables migration — submissions + interviews
 * Run: node migrate-pipeline.cjs
 */
const Database = require("better-sqlite3");
const path = require("path");

const dbPath = path.resolve(__dirname, "sqlite.db");
const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER REFERENCES applications(id),
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    candidate_id INTEGER NOT NULL REFERENCES candidates(id),
    status TEXT NOT NULL DEFAULT 'internal_submitted',
    client_name TEXT DEFAULT '',
    job_hiring_type TEXT DEFAULT 'Direct Client',
    candidate_ctc_type TEXT DEFAULT 'annual_salary',
    candidate_ctc REAL DEFAULT 0,
    reason_for_rejection TEXT DEFAULT '',
    rejection_comments TEXT DEFAULT '',
    submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    organization_id INTEGER REFERENCES organizations(id),
    submitted_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS interviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER REFERENCES applications(id),
    submission_id INTEGER REFERENCES submissions(id),
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    candidate_id INTEGER NOT NULL REFERENCES candidates(id),
    title TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    timezone TEXT DEFAULT 'Asia/Kolkata',
    interview_stage TEXT DEFAULT 'round_1',
    submission_stage TEXT DEFAULT 'internal',
    status TEXT NOT NULL DEFAULT 'scheduled',
    account_name TEXT DEFAULT '',
    end_client TEXT DEFAULT '',
    interviewer_ids TEXT DEFAULT '[]',
    duration_minutes INTEGER DEFAULT 60,
    sent_on TEXT DEFAULT '',
    organization_id INTEGER REFERENCES organizations(id),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

console.log("✅ Pipeline tables (submissions, interviews) ready.");
db.close();
