import { sql } from 'drizzle-orm';
import { db } from './index.js';

/**
 * Permanent, idempotent production schema sync.
 * Adds missing columns/tables required by current app code without dropping data.
 */
const STATEMENTS = [
  // accounts metadata
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS contract_value integer NOT NULL DEFAULT 0`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS tags text NOT NULL DEFAULT '[]'`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS alerts_enabled integer NOT NULL DEFAULT 0`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS short_logo_url text DEFAULT ''`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS long_logo_url text DEFAULT ''`,
  `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS organization_id integer`,
  `ALTER TABLE roles_permissions ADD COLUMN IF NOT EXISTS account_id integer REFERENCES accounts(id) ON DELETE CASCADE`,
  `CREATE TABLE IF NOT EXISTS account_portal_users (
    account_id integer NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT account_portal_user_unique UNIQUE (account_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS upload_assets (
    storage_path text PRIMARY KEY,
    url text NOT NULL,
    created_by integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id integer REFERENCES organizations(id) ON DELETE CASCADE,
    account_id integer REFERENCES accounts(id) ON DELETE CASCADE,
    created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `ALTER TABLE upload_assets ADD COLUMN IF NOT EXISTS account_id integer REFERENCES accounts(id) ON DELETE CASCADE`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version integer NOT NULL DEFAULT 0`,

  // Secure recruiter-owned resume ingestion and deterministic per-job ATS scores.
  `CREATE TABLE IF NOT EXISTS candidate_resumes (
    id serial PRIMARY KEY,
    candidate_id integer NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    organization_id integer REFERENCES organizations(id) ON DELETE CASCADE,
    created_by integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    original_filename text NOT NULL,
    storage_path text NOT NULL UNIQUE,
    mime_type text NOT NULL,
    byte_size integer NOT NULL,
    content_hash text NOT NULL,
    parse_status text NOT NULL DEFAULT 'pending',
    parse_error text,
    extracted_text text DEFAULT '',
    extracted_data text DEFAULT '{}',
    created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS candidate_resumes_candidate_idx ON candidate_resumes(candidate_id)`,
  `CREATE INDEX IF NOT EXISTS candidate_resumes_owner_idx ON candidate_resumes(organization_id, created_by)`,
  `CREATE TABLE IF NOT EXISTS candidate_job_scores (
    id serial PRIMARY KEY,
    candidate_id integer NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    resume_id integer REFERENCES candidate_resumes(id) ON DELETE SET NULL,
    job_id integer NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    organization_id integer REFERENCES organizations(id) ON DELETE CASCADE,
    created_by integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    resume_hash text NOT NULL,
    job_hash text NOT NULL,
    algorithm_version text NOT NULL,
    total_score real NOT NULL,
    components text NOT NULL DEFAULT '{}',
    matched_requirements text NOT NULL DEFAULT '[]',
    missing_requirements text NOT NULL DEFAULT '[]',
    warnings text NOT NULL DEFAULT '[]',
    created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT candidate_job_score_unique UNIQUE (candidate_id, job_id)
  )`,
  `CREATE INDEX IF NOT EXISTS candidate_job_scores_job_score_idx ON candidate_job_scores(job_id, total_score DESC)`,
  `CREATE INDEX IF NOT EXISTS candidate_job_scores_owner_idx ON candidate_job_scores(organization_id, created_by)`,

  // jobs assignment + pay (pay may already exist)
  `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS assigned_to integer`,
  `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pay_package_min real`,
  `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pay_package_max real`,
  `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pay_currency text DEFAULT 'INR'`,
  `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS account_id integer`,

  // applications assignment + stage link
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS assigned_to integer`,
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS job_stage_id integer`,
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS notes text DEFAULT ''`,
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS created_by integer`,
  `ALTER TABLE applications ADD COLUMN IF NOT EXISTS updated_at text DEFAULT CURRENT_TIMESTAMP`,

  // job stages color (Stages tab)
  `ALTER TABLE job_stages ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT '#6366f1'`,
  `ALTER TABLE job_stages ADD COLUMN IF NOT EXISTS stage_type text NOT NULL DEFAULT 'initial'`,

  // account stage templates color
  `ALTER TABLE account_stage_templates ADD COLUMN IF NOT EXISTS color text NOT NULL DEFAULT '#6366f1'`,
  `ALTER TABLE account_stage_templates ADD COLUMN IF NOT EXISTS stage_type text NOT NULL DEFAULT 'initial'`,

  // ensure job_stages table exists for older DBs
  `CREATE TABLE IF NOT EXISTS job_stages (
    id serial PRIMARY KEY,
    job_id integer NOT NULL,
    name text NOT NULL,
    order_index integer NOT NULL DEFAULT 0,
    stage_type text NOT NULL DEFAULT 'initial',
    color text NOT NULL DEFAULT '#6366f1',
    created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS account_stage_templates (
    id serial PRIMARY KEY,
    account_id integer NOT NULL,
    name text NOT NULL,
    order_index integer NOT NULL DEFAULT 0,
    stage_type text NOT NULL DEFAULT 'initial',
    color text NOT NULL DEFAULT '#6366f1',
    created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  // calendar (Overview tab) — create only if missing; columns match schema.ts
  `CREATE TABLE IF NOT EXISTS calendar_events (
    id serial PRIMARY KEY,
    title text NOT NULL,
    start_time text NOT NULL,
    end_time text NOT NULL,
    color text DEFAULT 'blue',
    event_type text DEFAULT 'general',
    candidate_id integer,
    candidate_name text DEFAULT '',
    job_profile text DEFAULT '',
    job_id integer,
    location text DEFAULT '',
    description text DEFAULT '',
    meeting_link text DEFAULT '',
    is_all_day integer DEFAULT 0,
    organization_id integer,
    created_by integer,
    created_at text NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  // Hot-path indexes for large local/prod datasets (idempotent).
  `CREATE INDEX IF NOT EXISTS candidates_created_by_created_at_idx ON candidates (created_by, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS candidates_job_id_idx ON candidates (job_id)`,
  `CREATE INDEX IF NOT EXISTS candidates_fingerprint_idx ON candidates (fingerprint)`,
  `CREATE INDEX IF NOT EXISTS candidates_match_score_idx ON candidates (created_by, match_score DESC)`,
  `CREATE INDEX IF NOT EXISTS applications_created_by_created_at_idx ON applications (created_by, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS applications_job_stage_idx ON applications (job_id, job_stage_id)`,
  `CREATE INDEX IF NOT EXISTS applications_status_updated_idx ON applications (created_by, status, updated_at)`,
  `CREATE INDEX IF NOT EXISTS submissions_submitted_by_at_idx ON submissions (submitted_by, submitted_at DESC)`,
  `CREATE INDEX IF NOT EXISTS submissions_job_id_status_idx ON submissions (job_id, status)`,
  `CREATE INDEX IF NOT EXISTS submissions_candidate_id_idx ON submissions (candidate_id)`,
  `CREATE INDEX IF NOT EXISTS interviews_created_by_start_idx ON interviews (created_by, start_time)`,
  `CREATE INDEX IF NOT EXISTS interviews_job_id_start_idx ON interviews (job_id, start_time)`,
  `CREATE INDEX IF NOT EXISTS calendar_events_created_by_start_idx ON calendar_events (created_by, start_time)`,
  `CREATE INDEX IF NOT EXISTS jobs_account_id_idx ON jobs (account_id)`,
  `CREATE INDEX IF NOT EXISTS jobs_created_by_status_idx ON jobs (created_by, status)`,
  `CREATE INDEX IF NOT EXISTS users_organization_id_idx ON users (organization_id)`,
  `CREATE INDEX IF NOT EXISTS candidates_name_prefix_idx ON candidates (lower(name) text_pattern_ops)`,
  `CREATE INDEX IF NOT EXISTS candidates_email_prefix_idx ON candidates (lower(email) text_pattern_ops)`,
] as const;

export async function ensureProdSchema(): Promise<void> {
  let applied = 0;
  let skipped = 0;

  for (const statement of STATEMENTS) {
    try {
      await db.execute(sql.raw(statement));
      applied += 1;
    } catch (error) {
      skipped += 1;
      console.warn('[ensureProdSchema] skipped:', statement.slice(0, 80), String(error));
    }
  }

  console.log(`[ensureProdSchema] done (ok=${applied}, skipped=${skipped})`);
}
