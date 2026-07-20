/**
 * Fresh demo bootstrap: wipe CRM + all users, keep schema, create only:
 *   recruiter@demo.com / Demo@12345
 *
 * Usage: npx tsx src/db/seed-recruiter-only.ts
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { sql } from 'drizzle-orm';
import { db } from './index.js';
import { organizations, users } from './schema.js';

const EMAIL = 'recruiter@demo.com';
const PASSWORD = 'Demo@12345';

async function main() {
  // Full data wipe (keep schema). CASCADE clears dependents.
  await db.execute(sql`
    TRUNCATE TABLE
      application_stage_history,
      applications,
      application_tags,
      job_stages,
      job_shortlists,
      jobs,
      contacts,
      account_stage_templates,
      accounts,
      candidate_group_members,
      candidate_groups,
      candidate_tags,
      candidates,
      notifications,
      submissions,
      interviews,
      calendar_events,
      employees,
      onboarding_workflows,
      tasks,
      campaigns,
      tags,
      integrations,
      roles_permissions,
      org_settings,
      saved_reports,
      users,
      organizations
    RESTART IDENTITY CASCADE
  `);

  const [org] = await db
    .insert(organizations)
    .values({
      name: 'Demo Agency',
      logo: '',
      defaults: JSON.stringify({
        defaultJobType: 'Full-time',
        defaultLocation: 'Remote',
        notifyOnApplication: true,
      }),
    })
    .returning();

  const hash = await bcrypt.hash(PASSWORD, 10);
  await db.insert(users).values({
    name: 'Alex Recruiter',
    email: EMAIL,
    password: hash,
    isVerified: 1,
    role: 'recruiter_admin',
    portalType: 'recruiter',
    organizationId: org.id,
  });

  console.log('Fresh DB ready — only login:');
  console.log(`  ${EMAIL}`);
  console.log(`  ${PASSWORD}`);
  console.log(`  org_id=${org.id}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
