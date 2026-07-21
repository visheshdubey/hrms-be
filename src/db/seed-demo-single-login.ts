/**
 * Destructive populated demo reset.
 *
 * Keeps the database schema, removes all application data and logins, then
 * creates a deterministic recruiter-only dataset with exactly one login:
 *   recruiter@demo.com / Demo@12345
 *
 * Usage: npm run db:demo:single
 */
Object.assign(process.env, {
  SEED_RESET: '1',
  SEED_FORCE: '1',
  SEED_SINGLE_LOGIN: '1',
  SEED_ACCOUNTS: '8',
  SEED_JOBS: '12',
  SEED_CANDIDATES: '36',
  SEED_APPLICATIONS: '40',
  SEED_TAGS: '8',
  SEED_GROUPS: '4',
});

await import('./seed-faker-full.js');
