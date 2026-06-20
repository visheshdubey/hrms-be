/**
 * Settings tables migration — org_settings + roles_permissions
 * Run: node migrate-settings.cjs
 */
const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.resolve(__dirname, "sqlite.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS org_settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL UNIQUE REFERENCES organizations(id),
    website TEXT DEFAULT '',
    description TEXT DEFAULT '',
    contact_phone TEXT DEFAULT '',
    contact_email TEXT DEFAULT '',
    logo_url TEXT DEFAULT '',
    favicon_url TEXT DEFAULT '',
    primary_color TEXT DEFAULT '#2563eb',
    billing_company TEXT DEFAULT '',
    billing_address TEXT DEFAULT '',
    billing_city TEXT DEFAULT '',
    billing_state TEXT DEFAULT '',
    billing_country TEXT DEFAULT '',
    billing_zip TEXT DEFAULT '',
    country TEXT DEFAULT 'India',
    currency TEXT DEFAULT 'INR',
    timezone TEXT DEFAULT 'Asia/Kolkata',
    date_format TEXT DEFAULT 'DD/MM/YYYY',
    time_format TEXT DEFAULT '12h',
    email_domain TEXT DEFAULT '',
    spf_record TEXT DEFAULT '',
    dkim_record TEXT DEFAULT '',
    dkim_verified INTEGER DEFAULT 0,
    inbox_forward_email TEXT DEFAULT '',
    parse_resumes INTEGER DEFAULT 1,
    configurations_json TEXT DEFAULT '{}',
    updated_by INTEGER REFERENCES users(id),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS roles_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id INTEGER NOT NULL REFERENCES organizations(id),
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    permissions_json TEXT DEFAULT '{}',
    members_json TEXT DEFAULT '[]',
    ip_addresses_json TEXT DEFAULT '[]',
    report_ids_json TEXT DEFAULT '[]',
    is_active INTEGER DEFAULT 1,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

console.log("✅ Settings tables (org_settings, roles_permissions) ready.");
db.close();
