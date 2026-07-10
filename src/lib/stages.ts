import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  accountStageTemplates,
  accounts,
  jobStages,
  jobs,
} from '../db/schema.js';
import { belongsToOrganization } from './orgScope.js';
import type { UserRole } from '../middleware.js';
import { defaultStageColor } from './stageColors.js';

export function canWriteStageTemplates(role: UserRole | null | undefined): boolean {
  return role === 'org_admin' || role === 'recruiter_admin';
}

export async function getAccountIfAccessible(
  accountId: number,
  userId: number,
  orgId: number | null,
) {
  const [account] = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
  if (!account) return null;
  if (!belongsToOrganization(account.organizationId, orgId, account.createdBy, userId)) {
    return null;
  }
  return account;
}

/** Copy client templates into a job when it has no stages yet. Returns count copied. */
export async function copyAccountStageTemplatesToJob(
  accountId: number,
  jobId: number,
): Promise<number> {
  const templates = await db
    .select()
    .from(accountStageTemplates)
    .where(eq(accountStageTemplates.accountId, accountId))
    .orderBy(accountStageTemplates.orderIndex);

  if (templates.length === 0) return 0;

  const existing = await db
    .select({ id: jobStages.id })
    .from(jobStages)
    .where(eq(jobStages.jobId, jobId))
    .limit(1);

  if (existing.length > 0) return 0;

  for (const template of templates) {
    await db.insert(jobStages).values({
      jobId,
      name: template.name,
      orderIndex: template.orderIndex,
      stageType: template.stageType,
      color: template.color ?? defaultStageColor(template.orderIndex),
    });
  }

  return templates.length;
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
