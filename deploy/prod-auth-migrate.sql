-- Minimal migration for prod register/auth (existing users/jobs/candidates preserved)
CREATE TABLE IF NOT EXISTS organizations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  logo TEXT DEFAULT '',
  defaults TEXT DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_verified INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS portal_type TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT DEFAULT 'australia';
ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'pst';
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active INTEGER DEFAULT 1;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_otp TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_otp_expiry TEXT;

-- Register/invite flow sets password later via email link
ALTER TABLE users ALTER COLUMN password DROP NOT NULL;
