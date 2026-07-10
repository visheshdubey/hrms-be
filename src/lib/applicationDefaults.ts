import { and, asc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { applications, jobStages, jobs } from '../db/schema.js';

export async function getFirstJobStageId(jobId: number): Promise<number | null> {
  const [stage] = await db
    .select({ id: jobStages.id })
    .from(jobStages)
    .where(eq(jobStages.jobId, jobId))
    .orderBy(asc(jobStages.orderIndex))
    .limit(1);

  return stage?.id ?? null;
}

export async function resolveNewApplicationDefaults(jobId: number) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  const jobStageId = await getFirstJobStageId(jobId);

  return {
    assignedTo: job?.assignedTo ?? null,
    jobStageId,
  };
}

export async function incrementJobApplicantCount(jobId: number, delta = 1) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) return;

  await db
    .update(jobs)
    .set({ applicants: Math.max(0, (job.applicants ?? 0) + delta) })
    .where(eq(jobs.id, jobId));
}

export async function applicationExists(jobId: number, candidateId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: applications.id })
    .from(applications)
    .where(and(eq(applications.jobId, jobId), eq(applications.candidateId, candidateId)))
    .limit(1);

  return Boolean(row);
}
