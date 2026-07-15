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
