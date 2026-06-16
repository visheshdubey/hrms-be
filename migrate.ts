import pkg from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

const { Pool } = pkg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function runMigrations() {
  const client = await pool.connect();
  try {
    // Create users table
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create jobs table
    await client.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        department TEXT NOT NULL DEFAULT 'General',
        status TEXT NOT NULL DEFAULT 'Active',
        type TEXT NOT NULL DEFAULT 'Full-time',
        location TEXT NOT NULL DEFAULT 'Remote',
        applicants INTEGER NOT NULL DEFAULT 0,
        description TEXT DEFAULT '',
        posted_date TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
      );
    `);

    // Create candidates table
    await client.query(`
      CREATE TABLE IF NOT EXISTS candidates (
        id SERIAL PRIMARY KEY,
        job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
        filename TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '',
        email TEXT NOT NULL DEFAULT '',
        phone TEXT DEFAULT '',
        location TEXT DEFAULT '',
        education TEXT DEFAULT '',
        experience TEXT DEFAULT '',
        skills TEXT DEFAULT '[]',
        match_score REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'New',
        linkedin TEXT DEFAULT '',
        github TEXT DEFAULT '',
        portfolio TEXT DEFAULT '',
        certifications TEXT DEFAULT '[]',
        languages TEXT DEFAULT '[]',
        summary TEXT DEFAULT '',
        university TEXT DEFAULT '',
        grad_year TEXT DEFAULT '',
        work_history TEXT DEFAULT '[]',
        fingerprint TEXT DEFAULT '',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
      );
    `);

    // Safe ALTER TABLE migrations
    const safeAddColumn = async (table: string, column: string, definition: string) => {
      try {
        await client.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
        console.log(`  ✅ Added ${column} to ${table}`);
      } catch (err: any) {
        // Error code 42701 is duplicate_column in Postgres
        if (err.code !== '42701') {
          console.error(`  ❌ Failed to add ${column} to ${table}:`, err.message);
        }
      }
    };

    // Migrations
    await safeAddColumn('candidates', 'created_by', 'INTEGER REFERENCES users(id)');
    await safeAddColumn('candidates', 'match_score', 'REAL NOT NULL DEFAULT 0');
    await safeAddColumn('candidates', 'linkedin', "TEXT DEFAULT ''");
    await safeAddColumn('candidates', 'github', "TEXT DEFAULT ''");
    await safeAddColumn('candidates', 'portfolio', "TEXT DEFAULT ''");
    await safeAddColumn('candidates', 'certifications', "TEXT DEFAULT '[]'");
    await safeAddColumn('candidates', 'languages', "TEXT DEFAULT '[]'");
    await safeAddColumn('candidates', 'summary', "TEXT DEFAULT ''");
    await safeAddColumn('candidates', 'university', "TEXT DEFAULT ''");
    await safeAddColumn('candidates', 'grad_year', "TEXT DEFAULT ''");
    await safeAddColumn('candidates', 'work_history', "TEXT DEFAULT '[]'");
    await safeAddColumn('candidates', 'fingerprint', "TEXT DEFAULT ''");

    // Indexes
    await client.query(`CREATE INDEX IF NOT EXISTS idx_jobs_created_by ON jobs(created_by);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_candidates_created_by ON candidates(created_by);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_candidates_match_score ON candidates(match_score);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_candidates_fingerprint ON candidates(fingerprint);`);
    
    console.log('✅ Indexes configured for multi-tenancy and performance.');
    console.log('✅ Migration complete: all tables configured (18-layer schema).');
  } catch (error) {
    console.error('Migration failed:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

runMigrations();
