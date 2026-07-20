import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  accountStageTemplates,
  accounts,
  jobStages,
  jobs,
} from '../db/schema.js';
import { belongsToOrganization, canAccessAccountId, isOrgPortalRole } from './orgScope.js';
import type { UserRole } from '../middleware.js';
import { defaultStageColor } from './stageColors.js';

export function canWriteStageTemplates(role: UserRole | null | undefined): boolean {
  return role === 'org_admin' || role === 'recruiter_admin';
}

/** Locked system stages every job must have. Delete/type-change disabled in API + UI. */
export const DEFAULT_JOB_STAGES = [
  { name: 'Start', orderIndex: 0, stageType: 'initial' as const, color: '#8b5cf6' },
  { name: 'Hired', orderIndex: 1, stageType: 'hired' as const, color: '#06b6d4' },
  { name: 'Rejected', orderIndex: 2, stageType: 'rejected' as const, color: '#ef4444' },
] as const;

/** Ensure Start / Hired / Rejected exist on a job (by stageType). Safe to re-run. */
export async function ensureDefaultJobStages(jobId: number): Promise<number> {
  const existing = await db
    .select({ id: jobStages.id, stageType: jobStages.stageType, orderIndex: jobStages.orderIndex })
    .from(jobStages)
    .where(eq(jobStages.jobId, jobId));

  const have = new Set(existing.map((s) => s.stageType));
  let maxOrder = existing.reduce((m, s) => Math.max(m, s.orderIndex), -1);
  let inserted = 0;

  for (const def of DEFAULT_JOB_STAGES) {
    if (have.has(def.stageType)) continue;
    maxOrder += 1;
    await db.insert(jobStages).values({
      jobId,
      name: def.name,
      orderIndex: def.stageType === 'initial' ? 0 : maxOrder,
      stageType: def.stageType,
      color: def.color,
    });
    inserted += 1;
  }

  return inserted;
}

export async function getAccountIfAccessible(
  accountId: number,
  userId: number,
  orgId: number | null,
  role?: UserRole | string | null,
) {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!account) return null;
  if (isOrgPortalRole(role)) {
    if (!(await canAccessAccountId(accountId, userId, orgId, role))) return null;
    return account;
  }
  if (!belongsToOrganization(account.organizationId, orgId, account.createdBy, userId)) {
    return null;
  }
  return account;
}

/** Copy client templates into a job when it has no stages yet. Always ensures Start/Hired/Rejected. */
export async function copyAccountStageTemplatesToJob(
  accountId: number,
  jobId: number,
): Promise<number> {
  const existing = await db
    .select({ id: jobStages.id })
    .from(jobStages)
    .where(eq(jobStages.jobId, jobId))
    .limit(1);

  if (existing.length > 0) {
    await ensureDefaultJobStages(jobId);
    return 0;
  }

  const templates = await db
    .select()
    .from(accountStageTemplates)
    .where(eq(accountStageTemplates.accountId, accountId))
    .orderBy(accountStageTemplates.orderIndex);

  const source = templates.length > 0
    ? templates.map((t) => ({
        name: t.name,
        orderIndex: t.orderIndex,
        stageType: t.stageType,
        color: t.color ?? defaultStageColor(t.orderIndex),
      }))
    : DEFAULT_JOB_STAGES.map((d) => ({
        name: d.name,
        orderIndex: d.orderIndex,
        stageType: d.stageType,
        color: d.color,
      }));

  for (const stage of source) {
    await db.insert(jobStages).values({
      jobId,
      name: stage.name,
      orderIndex: stage.orderIndex,
      stageType: stage.stageType,
      color: stage.color,
    });
  }

  await ensureDefaultJobStages(jobId);
  return source.length;
}

/** Apply templates to all account jobs that have no stages configured. */
export async function applyTemplatesToAccountJobsWithoutStages(
  accountId: number,
): Promise<{ jobsUpdated: number; stagesCopied: number }> {
  const accountJobs = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.accountId, accountId));

  let jobsUpdated = 0;
  let stagesCopied = 0;

  for (const job of accountJobs) {
    const copied = await copyAccountStageTemplatesToJob(accountId, job.id);
    if (copied > 0) {
      jobsUpdated += 1;
      stagesCopied += copied;
    }
  }

  return { jobsUpdated, stagesCopied };
}
