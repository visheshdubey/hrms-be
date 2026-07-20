/**
 * Fresh empty workspace: one org + recruiter@demo.com only.
 * Usage after reset: npx tsx src/db/seed-fresh-recruiter.ts
 */
import bcrypt from 'bcryptjs';
import { db } from './index.js';
import { organizations, users } from './schema.js';

const EMAIL = 'recruiter@demo.com';
const PASSWORD = 'Demo@12345';

async function main() {
  const hashed = await bcrypt.hash(PASSWORD, 10);

  const [org] = await db
    .insert(organizations)
    .values({
      name: 'Demo Recruitment Co.',
      logo: '',
      defaults: JSON.stringify({
        defaultJobType: 'Full-time',
        defaultLocation: 'Remote',
        notifyOnApplication: true,
      }),
    })
    .returning();

  const [user] = await db
    .insert(users)
    .values({
      name: 'Alex Recruiter',
      email: EMAIL,
      password: hashed,
      isVerified: 1,
      isActive: 1,
      role: 'recruiter_admin',
      portalType: 'recruiter',
      organizationId: org.id,
    })
    .returning();

  console.log('Fresh workspace ready — no clients/jobs/candidates.');
  console.log(`  Org:  ${org.name} (id=${org.id})`);
  console.log(`  User: ${user.email} / ${PASSWORD} (id=${user.id}, role=${user.role})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
