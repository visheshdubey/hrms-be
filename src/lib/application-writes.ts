import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  applications,
  applicationStageHistory,
  candidates,
  jobs,
  jobStages,
  APP_STATUSES,
} from '../db/schema.js';

type AppStatus = (typeof APP_STATUSES)[number];

export class ApplicationWriteConflictError extends Error {
  constructor() {
    super('APPLICATION_WRITE_CONFLICT');
  }
}

export type CreateApplicationInput = {
  candidateId: number;
  notes?: string;
};

/**
 * Creates a single or bulk set of applications under one per-job transaction.
 * The advisory lock also protects installations that predate the unique
 * (job_id, candidate_id) index; on current schemas the unique index is a
 * second line of defence.
 */
export async function createApplicationsAtomically(params: {
  jobId: number;
  userId: number;
  assignedTo: number;
  jobStageId?: number | null;
  applications: CreateApplicationInput[];
}) {
  const uniqueInputs = [...new Map(
    params.applications.map((input) => [input.candidateId, input]),
  ).values()];

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${params.jobId})`);

    let stageId = params.jobStageId;
    if (stageId == null) {
      const [firstStage] = await tx
        .select({ id: jobStages.id, stageType: jobStages.stageType })
        .from(jobStages)
        .where(and(
          eq(jobStages.jobId, params.jobId),
          inArray(jobStages.stageType, ['initial', 'in_transit']),
        ))
        .orderBy(jobStages.orderIndex)
        .limit(1);
      stageId = firstStage?.id ?? null;
    } else {
      const [stage] = await tx
        .select({ id: jobStages.id, stageType: jobStages.stageType })
        .from(jobStages)
        .where(and(eq(jobStages.id, stageId), eq(jobStages.jobId, params.jobId)))
        .limit(1);
      if (!stage || stage.stageType === 'hired' || stage.stageType === 'rejected') {
        throw new Error('INVALID_JOB_STAGE');
      }
    }

    const candidateIds = uniqueInputs.map((input) => input.candidateId);
    const existing = candidateIds.length === 0
      ? []
      : await tx
        .select({ candidateId: applications.candidateId })
        .from(applications)
        .where(and(
          eq(applications.jobId, params.jobId),
          inArray(applications.candidateId, candidateIds),
        ));
    const existingIds = new Set(existing.map((row) => row.candidateId));
    const created: Array<typeof applications.$inferSelect> = [];
    const skipped: number[] = [];

    for (const input of uniqueInputs) {
      if (existingIds.has(input.candidateId)) {
        skipped.push(input.candidateId);
        continue;
      }

      const [row] = await tx
        .insert(applications)
        .values({
          jobId: params.jobId,
          candidateId: input.candidateId,
          status: 'applied',
          notes: input.notes ?? '',
          assignedTo: params.assignedTo,
          jobStageId: stageId,
          createdBy: params.userId,
        })
        .onConflictDoNothing({
          target: [applications.jobId, applications.candidateId],
        })
        .returning();

      if (!row) {
        skipped.push(input.candidateId);
        continue;
      }

      await tx.insert(applicationStageHistory).values({
        applicationId: row.id,
        fromStatus: null,
        toStatus: 'applied',
        fromStageId: null,
        toStageId: stageId,
        note: 'Application created',
        changedBy: params.userId,
      });
      created.push(row);
    }

    if (created.length > 0) {
      await tx
        .update(jobs)
        .set({
          applicants: sql`greatest(0, coalesce(${jobs.applicants}, 0) + ${created.length})`,
        })
        .where(eq(jobs.id, params.jobId));
    }

    return { created, skipped };
  });
}

/**
 * Compare-and-swap application mutation. The application row, audit history,
 * and optional candidate status update commit or roll back together.
 */
export async function transitionApplicationAtomically(params: {
  applicationId: number;
  candidateId: number;
  expectedStatus: AppStatus;
  expectedStageId: number | null;
  nextStatus?: AppStatus;
  nextStageId?: number | null;
  assignedTo?: number;
  note: string;
  changedBy: number;
  candidateStatus?: string;
}) {
  return db.transaction(async (tx) => {
    const expectedStage = params.expectedStageId == null
      ? isNull(applications.jobStageId)
      : eq(applications.jobStageId, params.expectedStageId);
    const patch: Partial<typeof applications.$inferInsert> = {
      updatedAt: new Date().toISOString(),
    };
    if (params.nextStatus !== undefined) patch.status = params.nextStatus;
    if (params.nextStageId !== undefined) patch.jobStageId = params.nextStageId;
    if (params.assignedTo !== undefined) patch.assignedTo = params.assignedTo;

    const [updated] = await tx
      .update(applications)
      .set(patch)
      .where(and(
        eq(applications.id, params.applicationId),
        eq(applications.status, params.expectedStatus),
        expectedStage,
      ))
      .returning();

    if (!updated) throw new ApplicationWriteConflictError();

    const statusChanged = params.nextStatus !== undefined
      && params.nextStatus !== params.expectedStatus;
    const stageChanged = params.nextStageId !== undefined
      && params.nextStageId !== params.expectedStageId;
    if (statusChanged || stageChanged) {
      await tx.insert(applicationStageHistory).values({
        applicationId: params.applicationId,
        fromStatus: params.expectedStatus,
        toStatus: params.nextStatus ?? params.expectedStatus,
        fromStageId: params.expectedStageId,
        toStageId: params.nextStageId ?? params.expectedStageId,
        note: params.note,
        changedBy: params.changedBy,
      });
    }

    if (params.candidateStatus !== undefined) {
      await tx
        .update(candidates)
        .set({ status: params.candidateStatus })
        .where(eq(candidates.id, params.candidateId));
    }

    return updated;
  });
}
