/**
 * LOCAL-ONLY load seed for dashboard / list stress testing.
 *
 * Does NOT run in deploy pipelines. Never wire this into production scripts.
 *
 * Usage (local Docker Postgres only):
 *   npm run db:seed:local-50k
 *
 * Env overrides:
 *   LOCAL_LOAD_CANDIDATES=50000
 *   LOCAL_LOAD_APPLICATIONS=20000
 *   LOCAL_LOAD_SUBMISSIONS=8000
 *   LOCAL_LOAD_INTERVIEWS=3000
 */
import { faker } from '@faker-js/faker';
import { eq, sql } from 'drizzle-orm';
import { db } from './index.js';
import {
  applications,
  candidates,
  interviews,
  jobs,
  submissions,
  users,
} from './schema.js';

const DEMO_EMAIL = 'recruiter@demo.com';
const BATCH = 500;

const candidateTarget = Number(process.env.LOCAL_LOAD_CANDIDATES ?? 50_000);
const applicationTarget = Number(process.env.LOCAL_LOAD_APPLICATIONS ?? 20_000);
const submissionTarget = Number(process.env.LOCAL_LOAD_SUBMISSIONS ?? 8_000);
const interviewTarget = Number(process.env.LOCAL_LOAD_INTERVIEWS ?? 3_000);

const SKILLS = [
  'React',
  'TypeScript',
  'Node.js',
  'Python',
  'AWS',
  'Docker',
  'SQL',
  'GraphQL',
  'Java',
  'Figma',
] as const;

const APP_STATUSES = [
  'applied',
  'in_review',
  'shortlisted',
  'interview_scheduled',
  'hold',
  'offer',
  'rejected',
  'no_offer',
] as const;

const SUB_STATUSES = [
  'internal_submitted',
  'client_review',
  'client_interview_scheduled',
  'client_accepted',
  'client_rejected',
  'withdrawn',
] as const;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function seedLocal50k() {
  console.log('⚠️  LOCAL-ONLY seed — do not use for deploy / production.');
  faker.seed(20260722);

  const [admin] = await db.select().from(users).where(eq(users.email, DEMO_EMAIL)).limit(1);
  if (!admin) {
    throw new Error(
      `Demo user ${DEMO_EMAIL} not found. Run a normal local seed first (npm run db:seed:full or db:demo:single).`,
    );
  }
  const userId = admin.id;

  // Use any local jobs (not only ones created by the demo login) so load seed
  // works after manual job creation under other org users.
  const existingJobs = await db
    .select({ id: jobs.id, accountId: jobs.accountId })
    .from(jobs)
    .limit(200);

  if (existingJobs.length === 0) {
    throw new Error(
      'No jobs found in local DB. Create at least one job in the UI, then re-run this seed.',
    );
  }

  const jobIds = existingJobs.map((j) => j.id);
  console.log(
    `🌱 Local load: candidates=${candidateTarget}, applications=${applicationTarget}, submissions=${submissionTarget}, interviews=${interviewTarget}`,
  );

  let insertedCandidates = 0;
  const recentCandidateIds: number[] = [];

  while (insertedCandidates < candidateTarget) {
    const n = Math.min(BATCH, candidateTarget - insertedCandidates);
    const rows = Array.from({ length: n }, (_, idx) => {
      const i = insertedCandidates + idx;
      const skills = faker.helpers.arrayElements([...SKILLS], { min: 2, max: 5 });
      return {
        filename: `local_load_${i + 1}.pdf`,
        name: faker.person.fullName(),
        email: `local.load.${i + 1}.${faker.string.alphanumeric(6)}@example.local`,
        phone: faker.phone.number(),
        location: `${faker.location.city()}, ${faker.location.country()}`,
        education: faker.helpers.arrayElement(['B.Tech', 'M.Tech', 'B.Sc', 'MBA']),
        experience: `${faker.number.int({ min: 1, max: 15 })} years`,
        skills: JSON.stringify(skills),
        matchScore: faker.number.int({ min: 10, max: 99 }),
        status: faker.helpers.arrayElement(['New', 'In Review', 'Shortlisted', 'Interview', 'Rejected']),
        summary: faker.lorem.sentence(),
        jobId: faker.datatype.boolean(0.35) ? faker.helpers.arrayElement(jobIds) : null,
        createdBy: userId,
        createdAt: faker.date.recent({ days: 90 }).toISOString(),
      };
    });

    const inserted = await db.insert(candidates).values(rows).returning({ id: candidates.id });
    for (const row of inserted) {
      if (recentCandidateIds.length < 25_000) recentCandidateIds.push(row.id);
    }
    insertedCandidates += n;
    if (insertedCandidates % 5_000 === 0 || insertedCandidates === candidateTarget) {
      console.log(`   candidates ${insertedCandidates}/${candidateTarget}`);
    }
  }

  // Prefer recently inserted IDs for related rows (bounded memory).
  const candidatePool =
    recentCandidateIds.length > 0
      ? recentCandidateIds
      : (
          await db
            .select({ id: candidates.id })
            .from(candidates)
            .where(eq(candidates.createdBy, userId))
            .limit(25_000)
        ).map((r) => r.id);

  let appsCreated = 0;
  const appPairs = new Set<string>();
  const applicationRows: Array<{
    jobId: number;
    candidateId: number;
    status: (typeof APP_STATUSES)[number];
    createdBy: number;
    createdAt: string;
    updatedAt: string;
  }> = [];

  while (appsCreated < applicationTarget && applicationRows.length < applicationTarget) {
    const jobId = faker.helpers.arrayElement(jobIds);
    const candidateId = faker.helpers.arrayElement(candidatePool);
    const key = `${jobId}:${candidateId}`;
    if (appPairs.has(key)) continue;
    appPairs.add(key);
    const at = faker.date.recent({ days: 60 }).toISOString();
    applicationRows.push({
      jobId,
      candidateId,
      status: faker.helpers.arrayElement([...APP_STATUSES]),
      createdBy: userId,
      createdAt: at,
      updatedAt: at,
    });
    appsCreated += 1;
  }

  for (const part of chunk(applicationRows, BATCH)) {
    await db.insert(applications).values(part).onConflictDoNothing();
  }
  console.log(`   applications ~${applicationRows.length}`);

  const submissionRows = Array.from({ length: submissionTarget }, () => {
    const job = faker.helpers.arrayElement(existingJobs);
    const at = faker.date.recent({ days: 45 }).toISOString();
    return {
      jobId: job.id,
      candidateId: faker.helpers.arrayElement(candidatePool),
      status: faker.helpers.arrayElement([...SUB_STATUSES]),
      clientName: faker.company.name(),
      submittedAt: at,
      organizationId: admin.organizationId ?? null,
      submittedBy: userId,
      createdAt: at,
      updatedAt: at,
    };
  });
  for (const part of chunk(submissionRows, BATCH)) {
    await db.insert(submissions).values(part);
  }
  console.log(`   submissions ${submissionRows.length}`);

  const interviewRows = Array.from({ length: interviewTarget }, () => {
    const start = faker.date.recent({ days: 30 });
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    return {
      jobId: faker.helpers.arrayElement(jobIds),
      candidateId: faker.helpers.arrayElement(candidatePool),
      title: 'Interview',
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      interviewStage: faker.helpers.arrayElement(['round_1', 'round_2', 'round_3', 'final']),
      status: faker.helpers.arrayElement(['scheduled', 'completed', 'cancelled', 'no_show']),
      organizationId: admin.organizationId ?? null,
      createdBy: userId,
      createdAt: start.toISOString(),
      updatedAt: start.toISOString(),
    };
  });
  for (const part of chunk(interviewRows, BATCH)) {
    await db.insert(interviews).values(part);
  }
  console.log(`   interviews ${interviewRows.length}`);

  // Refresh denormalized applicants on a sample of jobs
  for (const jobId of jobIds.slice(0, 50)) {
    const [{ count }] = await db
      .select({ count: sql<number>`cast(count(*) as int)` })
      .from(applications)
      .where(eq(applications.jobId, jobId));
    await db.update(jobs).set({ applicants: Number(count ?? 0) }).where(eq(jobs.id, jobId));
  }

  console.log('✅ Local 50k load seed complete (local DB only).');
  console.log(`   Login: ${DEMO_EMAIL} / Demo@12345`);
}

seedLocal50k().catch((err) => {
  console.error('❌ Local load seed failed:', err);
  process.exit(1);
});
