/**
 * Stress-test data generator (faker.js).
 * Usage: npm run db:seed:stress
 * Env: STRESS_ACCOUNTS=150 STRESS_JOBS=1500 STRESS_CANDIDATES=500
 */
import { faker } from '@faker-js/faker';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from './index.js';
import {
  organizations,
  users,
  accounts,
  contacts,
  jobs,
  candidates,
  candidateGroups,
  candidateGroupMembers,
} from './schema.js';

const DEMO_EMAIL = 'recruiter@demo.com';
const DEMO_PASSWORD = 'Demo@12345';

const MANUAL_CANDIDATES = [
  { name: 'Alice Johnson', email: 'alice@demo.com', matchScore: 92, skills: ['React', 'TypeScript', 'Tailwind'] },
  { name: 'Bob Smith', email: 'bob@demo.com', matchScore: 78, skills: ['Node.js', 'PostgreSQL', 'Docker'] },
  { name: 'Charlie Brown', email: 'charlie@demo.com', matchScore: 88, skills: ['Python', 'FastAPI', 'AWS'] },
  { name: 'Diana Prince', email: 'diana@demo.com', matchScore: 95, skills: ['React', 'GraphQL', 'CI/CD'] },
  { name: 'Evan Miller', email: 'evan@demo.com', matchScore: 71, skills: ['Java', 'Spring', 'Kafka'] },
  { name: 'Fiona Garcia', email: 'fiona@demo.com', matchScore: 84, skills: ['Figma', 'UX Research', 'Prototyping'] },
  { name: 'George Hall', email: 'george@demo.com', matchScore: 80, skills: ['Go', 'Kubernetes', 'gRPC'] },
  { name: 'Hannah Lee', email: 'hannah@demo.com', matchScore: 89, skills: ['Vue', 'Nuxt', 'Pinia'] },
];

const JOB_STATUSES = ['new', 'draft', 'ready', 'submission_in_progress', 'closed'] as const;
const JOB_TYPES = ['Full-time', 'Part-time', 'Contract'] as const;
const JOB_LOCATIONS = ['Remote', 'On-site', 'Hybrid'] as const;

async function ensureDemoUser() {
  const existing = await db.select().from(users).where(eq(users.email, DEMO_EMAIL)).limit(1);
  if (existing.length > 0) return existing[0];

  const [org] = await db.insert(organizations).values({
    name: 'Demo Recruitment Co.',
    logo: '',
    defaults: JSON.stringify({ defaultJobType: 'Full-time', defaultLocation: 'Remote' }),
  }).returning();

  const hashedPassword = await bcrypt.hash(DEMO_PASSWORD, 10);
  const [admin] = await db.insert(users).values({
    name: 'Alex Recruiter',
    email: DEMO_EMAIL,
    password: hashedPassword,
    isVerified: 1,
    role: 'recruiter_admin',
    portalType: 'recruiter',
    organizationId: org.id,
  }).returning();

  return admin;
}

async function seedStress() {
  const accountCount = Number(process.env.STRESS_ACCOUNTS ?? 150);
  const jobCount = Number(process.env.STRESS_JOBS ?? 1500);
  const candidateCount = Number(process.env.STRESS_CANDIDATES ?? 500);

  faker.seed(42);
  const admin = await ensureDemoUser();
  const userId = admin.id;
  const orgId = admin.organizationId!;

  console.log(`🌱 Stress seed: ${accountCount} accounts, ${jobCount} jobs, ${candidateCount} candidates`);

  const accountIds: number[] = [];
  for (let i = 0; i < accountCount; i++) {
    const [row] = await db.insert(accounts).values({
      name: faker.company.name(),
      status: faker.helpers.arrayElement(['active', 'active', 'active', 'inactive', 'on_hold']),
      type: 'client',
      website: faker.internet.url(),
      description: faker.company.catchPhrase(),
      phone: faker.phone.number(),
      email: faker.internet.email(),
      address: faker.location.streetAddress(),
      city: faker.location.city(),
      state: faker.location.state(),
      country: faker.location.country(),
      organizationId: orgId,
      createdBy: userId,
      updatedAt: new Date().toISOString(),
    }).returning();
    accountIds.push(row.id);

    const contactN = faker.number.int({ min: 2, max: 5 });
    for (let c = 0; c < contactN; c++) {
      await db.insert(contacts).values({
        accountId: row.id,
        firstName: faker.person.firstName(),
        lastName: faker.person.lastName(),
        email: faker.internet.email(),
        phone: faker.phone.number(),
        jobTitle: faker.person.jobTitle(),
        department: faker.commerce.department(),
        status: 'active',
        organizationId: orgId,
        createdBy: userId,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  for (let i = 0; i < jobCount; i++) {
    await db.insert(jobs).values({
      title: faker.person.jobTitle(),
      department: faker.commerce.department(),
      status: faker.helpers.arrayElement(JOB_STATUSES),
      type: faker.helpers.arrayElement(JOB_TYPES),
      location: faker.helpers.arrayElement(JOB_LOCATIONS),
      applicants: 0,
      description: faker.lorem.paragraphs(2),
      accountId: faker.helpers.arrayElement(accountIds),
      createdBy: userId,
    });
  }

  const candidateIds: number[] = [];
  for (const c of MANUAL_CANDIDATES) {
    const [row] = await db.insert(candidates).values({
      filename: `${c.name.toLowerCase().replace(/\s+/g, '_')}_resume.pdf`,
      name: c.name,
      email: c.email,
      phone: faker.phone.number(),
      location: faker.location.city(),
      education: 'B.Tech Computer Science',
      experience: `${faker.number.int({ min: 2, max: 12 })} years`,
      skills: JSON.stringify(c.skills),
      matchScore: c.matchScore,
      status: faker.helpers.arrayElement(['New', 'In Review', 'Shortlisted', 'Interview']),
      summary: faker.lorem.paragraph(),
      linkedin: faker.internet.url(),
      github: `https://github.com/${c.email.split('@')[0]}`,
      createdBy: userId,
    }).returning();
    candidateIds.push(row.id);
  }

  const fakerTotal = Math.max(0, candidateCount - MANUAL_CANDIDATES.length);
  for (let i = 0; i < fakerTotal; i++) {
    const skills = faker.helpers.arrayElements(
      ['React', 'TypeScript', 'Node.js', 'Python', 'AWS', 'Docker', 'SQL', 'GraphQL', 'Java', 'Figma'],
      { min: 2, max: 5 },
    );
    const [row] = await db.insert(candidates).values({
      filename: faker.system.commonFileName('pdf'),
      name: faker.person.fullName(),
      email: faker.internet.email(),
      phone: faker.phone.number(),
      location: `${faker.location.city()}, ${faker.location.country()}`,
      education: faker.helpers.arrayElement(['B.Tech', 'M.Tech', 'B.Sc', 'MBA']),
      experience: `${faker.number.int({ min: 1, max: 15 })} years`,
      skills: JSON.stringify(skills),
      matchScore: faker.number.int({ min: 55, max: 99 }),
      status: faker.helpers.arrayElement(['New', 'In Review', 'Shortlisted', 'Interview', 'Rejected']),
      summary: faker.lorem.paragraph(),
      linkedin: faker.internet.url(),
      github: faker.internet.url(),
      createdBy: userId,
    }).returning();
    candidateIds.push(row.id);
  }

  const [groupA] = await db.insert(candidateGroups).values({
    organizationId: orgId,
    name: 'Senior React engineers',
    description: 'Frontend shortlist',
    createdBy: userId,
  }).returning();

  const [groupB] = await db.insert(candidateGroups).values({
    organizationId: orgId,
    name: 'Design pipeline',
    description: 'Product design candidates',
    createdBy: userId,
  }).returning();

  for (const cid of candidateIds.slice(0, 5)) {
    await db.insert(candidateGroupMembers).values({ groupId: groupA.id, candidateId: cid }).onConflictDoNothing();
  }
  if (candidateIds[5]) {
    await db.insert(candidateGroupMembers).values({ groupId: groupB.id, candidateId: candidateIds[5] }).onConflictDoNothing();
  }

  console.log('✅ Stress seed complete');
  console.log(`   Login: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
  console.log(`   Accounts: ${accountIds.length}, Jobs: ${jobCount}, Candidates: ${candidateIds.length}`);
}

seedStress().catch((err) => {
  console.error('❌ Stress seed failed:', err);
  process.exit(1);
});
