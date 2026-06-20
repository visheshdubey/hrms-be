/**
 * HRM tables migration — employees + onboarding_workflows
 * Run: node migrate-hrm.cjs
 */
const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.resolve(__dirname, "sqlite.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_code TEXT NOT NULL,
    user_id INTEGER REFERENCES users(id),
    candidate_id INTEGER REFERENCES candidates(id),
    application_id INTEGER REFERENCES applications(id),
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    phone TEXT DEFAULT '',
    job_title TEXT DEFAULT '',
    department TEXT DEFAULT '',
    employment_type TEXT NOT NULL DEFAULT 'full_time',
    status TEXT NOT NULL DEFAULT 'active',
    reporting_to_id INTEGER REFERENCES employees(id),
    hire_date TEXT DEFAULT '',
    organization_id INTEGER REFERENCES organizations(id),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS onboarding_workflows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_code TEXT NOT NULL,
    employee_id INTEGER REFERENCES employees(id),
    candidate_id INTEGER REFERENCES candidates(id),
    status TEXT NOT NULL DEFAULT 'draft',
    tasks_json TEXT DEFAULT '[]',
    documents_json TEXT DEFAULT '[]',
    notes TEXT DEFAULT '',
    organization_id INTEGER REFERENCES organizations(id),
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

console.log("✅ HRM tables (employees, onboarding_workflows) ready.");
db.close();
