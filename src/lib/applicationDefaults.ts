import { and, asc, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { applications, jobStages, jobs, APP_STATUSES } from '../db/schema.js';

type AppStatus = (typeof APP_STATUSES)[number];

/** Map application status → relative position in the job's stage list (0..1). */
const STATUS_STAGE_RATIO: Record<AppStatus, number> = {
  applied: 0,
  in_review: 0.15,
  shortlisted: 0.35,
  interview_scheduled: 0.55,
  hold: 0.55,
  offer: 0.8,
  no_offer: 1,
  rejected: 1,
};

export async function getFirstJobStageId(jobId: number): Promise<number | null> {
  const [stage] = await db
    .select({ id: jobStages.id })
    .from(jobStages)
    .where(eq(jobStages.jobId, jobId))
    .orderBy(asc(jobStages.orderIndex))
    .limit(1);

  return stage?.id ?? null;
}

export function pickStageIdForStatus(
  status: string,
  stages: Array<{ id: number }>,
): number | null {
  if (stages.length === 0) return null;
  const ratio = STATUS_STAGE_RATIO[status as AppStatus] ?? 0;
  const index = Math.min(
    stages.length - 1,
    Math.max(0, Math.round(ratio * (stages.length - 1))),
  );
  return stages[index]?.id ?? null;
}

/**
 * Persist job_stage_id for applications that still have null after schema upgrades.
 * Idempotent — only updates rows where job_stage_id IS NULL.
 */
export async function backfillNullApplicationStages(jobId: number): Promise<number> {
  const stages = await db
    .select({ id: jobStages.id })
    .from(jobStages)
    .where(eq(jobStages.jobId, jobId))
    .orderBy(asc(jobStages.orderIndex));

  if (stages.length === 0) return 0;

  const orphans = await db
    .select({ id: applications.id, status: applications.status })
    .from(applications)
    .where(and(eq(applications.jobId, jobId), isNull(applications.jobStageId)));

  let updated = 0;
  for (const app of orphans) {
    const stageId = pickStageIdForStatus(app.status, stages);
    if (stageId == null) continue;
    await db
      .update(applications)
      .set({ jobStageId: stageId, updatedAt: new Date().toISOString() })
      .where(eq(applications.id, app.id));
    updated += 1;
  }

  return updated;
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
