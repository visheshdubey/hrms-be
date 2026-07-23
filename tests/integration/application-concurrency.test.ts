import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { configureSafeTestDatabase } from '../test-environment.js';

configureSafeTestDatabase();

const { db } = await import('../../src/db/index.js');
const schema = await import('../../src/db/schema.js');
const {
  ApplicationWriteConflictError,
  createApplicationsAtomically,
  transitionApplicationAtomically,
} = await import('../../src/lib/application-writes.js');

const {
  applications,
  applicationStageHistory,
  candidates,
  jobStages,
  jobs,
  organizations,
  users,
} = schema;

let organizationId: number;
let userId: number;
let jobId: number;
let candidateId: number;
let initialStageId: number;
let hiredStageId: number;
let rejectedStageId: number;

before(async () => {
  // Fail clearly when the caller forgot to prepare the isolated schema.
  await db.execute(sql`select 1 from applications limit 0`);
  const suffix = `${Date.now()}-${process.pid}`;
  const [organization] = await db.insert(organizations)
    .values({ name: `Concurrency Test ${suffix}` })
    .returning();
  organizationId = organization.id;
  const [user] = await db.insert(users).values({
    name: 'Concurrency Tester',
    email: `concurrency-${suffix}@test.local`,
    role: 'recruiter_admin',
    portalType: 'recruiter',
    organizationId,
  }).returning();
  userId = user.id;
  const [job] = await db.insert(jobs).values({
    title: `Concurrency Job ${suffix}`,
    status: 'submission_in_progress',
    createdBy: userId,
    assignedTo: userId,
  }).returning();
  jobId = job.id;
  const stages = await db.insert(jobStages).values([
    { jobId, name: 'Start', orderIndex: 0, stageType: 'initial' },
    { jobId, name: 'Hired', orderIndex: 1, stageType: 'hired' },
    { jobId, name: 'Rejected', orderIndex: 2, stageType: 'rejected' },
  ]).returning();
  initialStageId = stages.find((stage) => stage.stageType === 'initial')!.id;
  hiredStageId = stages.find((stage) => stage.stageType === 'hired')!.id;
  rejectedStageId = stages.find((stage) => stage.stageType === 'rejected')!.id;
  const [candidate] = await db.insert(candidates).values({
    filename: `concurrency-${suffix}.txt`,
    name: 'Concurrent Candidate',
    email: `candidate-${suffix}@test.local`,
    createdBy: userId,
  }).returning();
  candidateId = candidate.id;
});

after(async () => {
  if (!jobId) return;
  await db.delete(applicationStageHistory).where(
    sql`${applicationStageHistory.applicationId} in (
      select id from applications where job_id = ${jobId}
    )`,
  );
  await db.delete(applications).where(eq(applications.jobId, jobId));
  await db.delete(jobStages).where(eq(jobStages.jobId, jobId));
  await db.delete(candidates).where(eq(candidates.id, candidateId));
  await db.delete(jobs).where(eq(jobs.id, jobId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(organizations).where(eq(organizations.id, organizationId));
});

test('concurrent duplicate creates produce one application and one audit row', async () => {
  const create = () => createApplicationsAtomically({
    jobId,
    userId,
    assignedTo: userId,
    jobStageId: initialStageId,
    applications: [{ candidateId }],
  });
  const results = await Promise.all([create(), create(), create()]);

  assert.equal(results.flatMap((result) => result.created).length, 1);
  assert.equal(results.flatMap((result) => result.skipped).length, 2);

  const rows = await db.select().from(applications).where(and(
    eq(applications.jobId, jobId),
    eq(applications.candidateId, candidateId),
  ));
  assert.equal(rows.length, 1);
  const history = await db.select().from(applicationStageHistory)
    .where(eq(applicationStageHistory.applicationId, rows[0].id));
  assert.equal(history.length, 1);
  const [job] = await db.select({ applicants: jobs.applicants })
    .from(jobs)
    .where(eq(jobs.id, jobId));
  assert.equal(job.applicants, 1);
});

test('concurrent conflicting terminal transitions allow exactly one winner', async () => {
  const [application] = await db.select().from(applications).where(and(
    eq(applications.jobId, jobId),
    eq(applications.candidateId, candidateId),
  ));
  const mutate = (nextStatus: 'offer' | 'rejected', nextStageId: number, candidateStatus: string) =>
    transitionApplicationAtomically({
      applicationId: application.id,
      candidateId,
      expectedStatus: 'applied',
      expectedStageId: initialStageId,
      nextStatus,
      nextStageId,
      note: `Concurrent ${nextStatus}`,
      changedBy: userId,
      candidateStatus,
    });

  const settled = await Promise.allSettled([
    mutate('offer', hiredStageId, 'Hired'),
    mutate('rejected', rejectedStageId, 'Rejected'),
  ]);
  assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = settled.find((result) => result.status === 'rejected');
  assert(rejected?.status === 'rejected');
  assert(rejected.reason instanceof ApplicationWriteConflictError);

  const [finalApplication] = await db.select().from(applications)
    .where(eq(applications.id, application.id));
  const [finalCandidate] = await db.select({ status: candidates.status }).from(candidates)
    .where(eq(candidates.id, candidateId));
  assert.equal(
    finalCandidate.status,
    finalApplication.status === 'offer' ? 'Hired' : 'Rejected',
  );
  const history = await db.select().from(applicationStageHistory)
    .where(eq(applicationStageHistory.applicationId, application.id));
  assert.equal(history.length, 2);
});
