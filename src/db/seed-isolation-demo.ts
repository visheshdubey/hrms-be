/**
 * Local isolation smoke data:
 *   recruiter@demo.com  — sees BOTH clients + BOTH jobs
 *   client-a@demo.com   — sees only Acme jobs
 *   client-b@demo.com   — sees only Globex jobs
 *
 * Usage (docker postgres up):
 *   npx tsx src/db/seed-isolation-demo.ts
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from './index.js';
import { accounts, contacts, jobs, organizations, users } from './schema.js';

const PASSWORD = 'Demo@12345';

async function upsertUser(input: {
  name: string;
  email: string;
  role: 'recruiter_admin' | 'org_admin';
  portalType: 'recruiter' | 'org';
  organizationId: number;
}) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);
  if (existing[0]) {
    await db
      .update(users)
      .set({
        name: input.name,
        password: hash,
        isVerified: 1,
        role: input.role,
        portalType: input.portalType,
        organizationId: input.organizationId,
      })
      .where(eq(users.id, existing[0].id));
    return existing[0].id;
  }
  const [row] = await db
    .insert(users)
    .values({
      name: input.name,
      email: input.email,
      password: hash,
      isVerified: 1,
      role: input.role,
      portalType: input.portalType,
      organizationId: input.organizationId,
    })
    .returning({ id: users.id });
  return row.id;
}

async function main() {
  let [org] = await db.select().from(organizations).limit(1);
  if (!org) {
    [org] = await db.insert(organizations).values({ name: 'Demo Agency' }).returning();
  }

  const recruiterId = await upsertUser({
    name: 'Alex Recruiter',
    email: 'recruiter@demo.com',
    role: 'recruiter_admin',
    portalType: 'recruiter',
    organizationId: org.id,
  });

  // Wipe prior demo CRM rows in this org (keep org + users we upsert)
  const oldAccounts = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.organizationId, org.id));
  for (const a of oldAccounts) {
    await db.delete(jobs).where(eq(jobs.accountId, a.id));
    await db.delete(contacts).where(eq(contacts.accountId, a.id));
    await db.delete(accounts).where(eq(accounts.id, a.id));
  }

  const now = new Date().toISOString();
  const [acme] = await db
    .insert(accounts)
    .values({
      name: 'Acme Corp',
      status: 'active',
      type: 'client',
      email: 'client-a@demo.com',
      organizationId: org.id,
      createdBy: recruiterId,
      updatedAt: now,
    })
    .returning();
  const [globex] = await db
    .insert(accounts)
    .values({
      name: 'Globex Inc',
      status: 'active',
      type: 'client',
      email: 'client-b@demo.com',
      organizationId: org.id,
      createdBy: recruiterId,
      updatedAt: now,
    })
    .returning();

  const clientAId = await upsertUser({
    name: 'Acme Admin',
    email: 'client-a@demo.com',
    role: 'org_admin',
    portalType: 'org',
    organizationId: org.id,
  });
  const clientBId = await upsertUser({
    name: 'Globex Admin',
    email: 'client-b@demo.com',
    role: 'org_admin',
    portalType: 'org',
    organizationId: org.id,
  });

  await db.insert(contacts).values([
    {
      accountId: acme.id,
      firstName: 'Acme',
      lastName: 'Admin',
      email: 'client-a@demo.com',
      status: 'active',
      organizationId: org.id,
      createdBy: recruiterId,
      updatedAt: now,
    },
    {
      accountId: globex.id,
      firstName: 'Globex',
      lastName: 'Admin',
      email: 'client-b@demo.com',
      status: 'active',
      organizationId: org.id,
      createdBy: recruiterId,
      updatedAt: now,
    },
  ]);

  await db.insert(jobs).values([
    {
      title: 'Acme Backend Engineer',
      department: 'Engineering',
      status: 'draft',
      type: 'Full-time',
      location: 'Remote',
      description: 'Only Acme should see this',
      accountId: acme.id,
      createdBy: clientAId,
      applicants: 0,
    },
    {
      title: 'Globex Frontend Engineer',
      department: 'Engineering',
      status: 'draft',
      type: 'Full-time',
      location: 'Hybrid',
      description: 'Only Globex should see this',
      accountId: globex.id,
      createdBy: clientBId,
      applicants: 0,
    },
  ]);

  console.log('Isolation demo ready (password for all: Demo@12345)');
  console.log('  recruiter@demo.com  → Clients: Acme + Globex; Jobs: both');
  console.log('  client-a@demo.com   → Jobs: Acme only');
  console.log('  client-b@demo.com   → Jobs: Globex only');
  console.log(`  org_id=${org.id} acme=${acme.id} globex=${globex.id}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
