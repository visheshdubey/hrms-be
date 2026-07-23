import { db } from '../db/index.js';
import { applications, candidates, interviews, jobs, submissions, users } from '../db/schema.js';
import { and, eq, inArray } from 'drizzle-orm';
import {
  canAccessByCreator,
  canAccessJob,
  getOrgMemberIds,
  isOrgPortalRole,
} from './orgScope.js';
import type { UserRole } from '../middleware.js';

/** Recruiter-workspace members only (excludes client portal users sharing the same org id). */
export async function getRecruiterMemberIds(
  orgId: number | null,
  userId: number,
): Promise<number[]> {
  if (orgId == null) return [userId];

  const members = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.organizationId, orgId), eq(users.portalType, 'recruiter')));

  const ids = members.map((m) => m.id);
  return ids.length > 0 ? ids : [userId];
}

export async function getJobIfAccessible(
  jobId: number,
  userId: number,
  orgId: number | null,
  role?: UserRole | string | null,
) {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job || !(await canAccessJob(job, userId, orgId, role))) return null;
  return job;
}

export async function canAccessCandidateIds(
  candidateIds: number[],
  userId: number,
  orgId: number | null,
): Promise<boolean> {
  if (candidateIds.length === 0) return true;
  const rows = await db
    .select({ id: candidates.id, createdBy: candidates.createdBy })
    .from(candidates)
    .where(inArray(candidates.id, candidateIds));
  if (rows.length !== candidateIds.length) return false;
  for (const row of rows) {
    if (!(await canAccessByCreator(orgId, userId, row.createdBy))) return false;
  }
  return true;
}

export async function getApplicationIfAccessible(
  applicationId: number,
  userId: number,
  orgId: number | null,
  role?: UserRole | string | null,
) {
  const [row] = await db.select().from(applications).where(eq(applications.id, applicationId)).limit(1);
  if (!row) return null;
  const job = await getJobIfAccessible(row.jobId, userId, orgId, role);
  if (!job) return null;
  return row;
}

export async function getSubmissionIfAccessible(
  submissionId: number,
  userId: number,
  orgId: number | null,
) {
  const [row] = await db.select().from(submissions).where(eq(submissions.id, submissionId)).limit(1);
  if (!row) return null;

  if (orgId != null && row.organizationId != null && row.organizationId !== orgId) {
    return null;
  }

  const memberIds = await getRecruiterMemberIds(orgId, userId);
  if (row.submittedBy != null && !memberIds.includes(row.submittedBy)) {
    // Fallback: job access (submission may be legacy without submittedBy in members)
    const job = await getJobIfAccessible(row.jobId, userId, orgId, 'recruiter_admin');
    if (!job) return null;
  }
  return row;
}

export async function getInterviewIfAccessible(
  interviewId: number,
  userId: number,
  orgId: number | null,
) {
  const [row] = await db.select().from(interviews).where(eq(interviews.id, interviewId)).limit(1);
  if (!row) return null;

  if (orgId != null && row.organizationId != null && row.organizationId !== orgId) {
    return null;
  }

  const memberIds = await getRecruiterMemberIds(orgId, userId);
  if (row.createdBy != null && !memberIds.includes(row.createdBy)) {
    const job = await getJobIfAccessible(row.jobId, userId, orgId, 'recruiter_admin');
    if (!job) return null;
  }
  return row;
}

export function assertNotOrgPortal(role: UserRole | string | null | undefined): boolean {
  return !isOrgPortalRole(role);
}

/** Re-export for routes that previously imported getOrgMemberIds for recruiter lists. */
export { getOrgMemberIds };
