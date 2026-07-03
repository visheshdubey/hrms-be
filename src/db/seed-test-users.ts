/**
 * Upsert demo login accounts for every portal role.
 * Safe to re-run — updates password/role without wiping other data.
 *
 * Usage: npm run db:seed:users
 */
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from './index.js';
import { organizations, users } from './schema.js';

const DEMO_PASSWORD = 'Demo@12345';

const TEST_USERS = [
  {
    name: 'Alex Recruiter',
    email: 'recruiter@demo.com',
    role: 'recruiter_admin' as const,
    portalType: 'recruiter' as const,
  },
  {
    name: 'Sam Staff',
    email: 'staff@demo.com',
    role: 'recruited_staff' as const,
    portalType: 'recruiter' as const,
  },
  {
    name: 'Olivia Org Admin',
    email: 'orgadmin@demo.com',
    role: 'org_admin' as const,
    portalType: 'org' as const,
  },
  {
    name: 'Owen Org Staff',
    email: 'orgstaff@demo.com',
    role: 'org_staff' as const,
    portalType: 'org' as const,
  },
];

async function resolveOrganizationId(): Promise<number> {
  const [recruiter] = await db
    .select()
    .from(users)
    .where(eq(users.email, 'recruiter@demo.com'))
    .limit(1);

  if (recruiter?.organizationId) {
    return recruiter.organizationId;
  }

  const [anyUser] = await db
    .select({ organizationId: users.organizationId })
    .from(users)
    .limit(1);

  if (anyUser?.organizationId) {
    return anyUser.organizationId;
  }

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

  return org.id;
}

async function seedTestUsers() {
  try {
    console.log('🔐 Seeding test portal logins…');

    const orgId = await resolveOrganizationId();
    const hashedPassword = await bcrypt.hash(DEMO_PASSWORD, 10);

    for (const user of TEST_USERS) {
      await db
        .insert(users)
        .values({
          name: user.name,
          email: user.email,
          password: hashedPassword,
          isVerified: 1,
          role: user.role,
          portalType: user.portalType,
          organizationId: orgId,
        })
        .onConflictDoUpdate({
          target: users.email,
          set: {
            name: user.name,
            password: hashedPassword,
            isVerified: 1,
            role: user.role,
            portalType: user.portalType,
            organizationId: orgId,
            isActive: 1,
          },
        });
    }

    console.log('✅ Test portal logins ready (password for all: Demo@12345)\n');
    console.log('┌─────────────────────┬────────────────────────┬──────────────────┬──────────┐');
    console.log('│ Portal              │ Email                  │ Role             │ Password │');
    console.log('├─────────────────────┼────────────────────────┼──────────────────┼──────────┤');
    console.log('│ Recruiter           │ recruiter@demo.com     │ recruiter_admin  │ Demo@12345│');
    console.log('│ Recruiter           │ staff@demo.com         │ recruited_staff  │ Demo@12345│');
    console.log('│ Org / Client        │ orgadmin@demo.com      │ org_admin        │ Demo@12345│');
    console.log('│ Org / Client        │ orgstaff@demo.com      │ org_staff        │ Demo@12345│');
    console.log('└─────────────────────┴────────────────────────┴──────────────────┴──────────┘');
    console.log(`\n   Organization ID: ${orgId}`);
  } catch (err) {
    console.error('❌ Test user seed failed:', err);
    process.exit(1);
  }
}

seedTestUsers();
