import { Hono } from 'hono';
import { db } from '../db/index.js';
import { accounts, jobs, candidates, users, applications } from '../db/schema.js';
import { eq, desc, and, or, sql, inArray, isNull } from 'drizzle-orm';
import { requireAuth, type AppContext, type UserRole } from '../middleware.js';
import {
  getAccessibleAccountIds,
  getOrgMemberIds,
  isOrgPortalRole,
  orgOrCreatorScope,
} from '../lib/orgScope.js';
import { isSchemaDriftError } from '../lib/schemaDrift.js';

const dashboardRouter = new Hono<AppContext>({ strict: false });

dashboardRouter.get('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const orgPortal = isOrgPortalRole(role);

    const memberIds = await getOrgMemberIds(orgId, userId);
    const accountIds = await getAccessibleAccountIds(userId, orgId, role);

    // --- Stats ---

    let totalClients = 0;
    if (orgPortal) {
      totalClients = accountIds.length;
    } else {
      try {
        const clientCountRows = await db
          .select({ count: sql<number>`count(*)` })
          .from(accounts)
          .where(orgOrCreatorScope(orgId, userId, accounts, accounts));
        totalClients = Number(clientCountRows[0]?.count ?? 0);
      } catch (error) {
        if (!isSchemaDriftError(error)) throw error;
        const clientCountRows = await db
          .select({ count: sql<number>`count(*)` })
          .from(accounts)
          .where(inArray(accounts.createdBy, memberIds));
        totalClients = Number(clientCountRows[0]?.count ?? 0);
      }
    }

    // Candidates pool is recruiter-owned; org portal should not see agency-wide counts.
    const totalCandidates = orgPortal
      ? 0
      : Number(
          (
            await db
              .select({ cnt: sql<number>`count(*)` })
              .from(candidates)
              .where(
                memberIds.length === 1
                  ? eq(candidates.createdBy, userId)
                  : inArray(candidates.createdBy, memberIds),
              )
          )[0]?.cnt ?? 0,
        );

    let totalApplications = 0;
    let activeJobs = 0;

    if (orgPortal) {
      const jobScope =
        accountIds.length > 0
          ? or(
              inArray(jobs.accountId, accountIds),
              and(isNull(jobs.accountId), eq(jobs.createdBy, userId)),
            )
          : and(isNull(jobs.accountId), eq(jobs.createdBy, userId));

      const clientJobs = await db.select({ id: jobs.id }).from(jobs).where(jobScope!);
      const jobIds = clientJobs.map((j) => j.id);

      activeJobs = Number(
        (
          await db
            .select({ cnt: sql<number>`count(*)` })
            .from(jobs)
            .where(and(eq(jobs.status, 'submission_in_progress'), jobScope!))
        )[0]?.cnt ?? 0,
      );

      if (jobIds.length > 0) {
        totalApplications = Number(
          (
            await db
              .select({ cnt: sql<number>`count(*)` })
              .from(applications)
              .where(inArray(applications.jobId, jobIds))
          )[0]?.cnt ?? 0,
        );
      }
    } else {
      totalApplications =
        memberIds.length === 1
          ? Number(
              (
                await db
                  .select({ cnt: sql<number>`count(*)` })
                  .from(applications)
                  .where(eq(applications.createdBy, userId))
              )[0]?.cnt ?? 0,
            )
          : Number(
              (
                await db
                  .select({ cnt: sql<number>`count(*)` })
                  .from(applications)
                  .where(inArray(applications.createdBy, memberIds))
              )[0]?.cnt ?? 0,
            );

      const activeJobsWhere =
        memberIds.length === 1
          ? and(eq(jobs.status, 'submission_in_progress'), eq(jobs.createdBy, userId))
          : and(eq(jobs.status, 'submission_in_progress'), inArray(jobs.createdBy, memberIds));
      activeJobs = Number(
        (await db.select({ cnt: sql<number>`count(*)` }).from(jobs).where(activeJobsWhere))[0]?.cnt ??
          0,
      );
    }

    const totalUsers = orgPortal ? 1 : memberIds.length;

    // --- My Jobs ---
    const myJobsWhere = orgPortal
      ? accountIds.length > 0
        ? or(
            inArray(jobs.accountId, accountIds),
            and(isNull(jobs.accountId), eq(jobs.createdBy, userId)),
          )
        : and(isNull(jobs.accountId), eq(jobs.createdBy, userId))
      : or(eq(jobs.createdBy, userId), eq(jobs.assignedTo, userId));

    const myJobsRows = await db
      .select({
        id: jobs.id,
        title: jobs.title,
        department: jobs.department,
        location: jobs.location,
        status: jobs.status,
        applicants: jobs.applicants,
        accountId: jobs.accountId,
        accountName: accounts.name,
      })
      .from(jobs)
      .leftJoin(accounts, eq(jobs.accountId, accounts.id))
      .where(myJobsWhere!)
      .orderBy(desc(jobs.id))
      .limit(20);

    const myJobs = myJobsRows.map((row) => ({
      id: row.id,
      title: row.title,
      department: row.department ?? 'General',
      location: row.location ?? 'Remote',
      status: row.status,
      applicants: row.applicants ?? 0,
      accountId: row.accountId ?? null,
      accountName: row.accountName ?? '',
    }));

    // --- Recent Applications ---
    let recentApplications: Array<{
      id: number;
      applicationId: number;
      candidateId: number;
      jobId: number;
      status: string;
      createdAt: string;
      name: string | null;
      filename: string | null;
      matchScore: number | null;
      jobTitle: string | null;
    }> = [];

    if (orgPortal) {
      const scopedJobIds = myJobsRows.map((j) => j.id);
      if (scopedJobIds.length > 0) {
        const recentAppRows = await db
          .select({
            id: applications.id,
            candidateId: applications.candidateId,
            jobId: applications.jobId,
            status: applications.status,
            createdAt: applications.createdAt,
            name: candidates.name,
            filename: candidates.filename,
            matchScore: candidates.matchScore,
            jobTitle: jobs.title,
          })
          .from(applications)
          .innerJoin(candidates, eq(applications.candidateId, candidates.id))
          .innerJoin(jobs, eq(applications.jobId, jobs.id))
          .where(inArray(applications.jobId, scopedJobIds))
          .orderBy(desc(applications.createdAt))
          .limit(10);

        recentApplications = recentAppRows.map((row) => ({
          id: row.id,
          applicationId: row.id,
          candidateId: row.candidateId,
          jobId: row.jobId,
          status: row.status,
          createdAt: row.createdAt,
          name: row.name,
          filename: row.filename,
          matchScore: row.matchScore,
          jobTitle: row.jobTitle ?? null,
        }));
      }
    } else {
      const appWhere =
        memberIds.length === 1
          ? eq(applications.createdBy, userId)
          : inArray(applications.createdBy, memberIds);

      const recentAppRows = await db
        .select({
          id: applications.id,
          candidateId: applications.candidateId,
          jobId: applications.jobId,
          status: applications.status,
          createdAt: applications.createdAt,
          name: candidates.name,
          filename: candidates.filename,
          matchScore: candidates.matchScore,
          jobTitle: jobs.title,
        })
        .from(applications)
        .innerJoin(candidates, eq(applications.candidateId, candidates.id))
        .innerJoin(jobs, eq(applications.jobId, jobs.id))
        .where(appWhere)
        .orderBy(desc(applications.createdAt))
        .limit(10);

      recentApplications = recentAppRows.map((row) => ({
        id: row.id,
        applicationId: row.id,
        candidateId: row.candidateId,
        jobId: row.jobId,
        status: row.status,
        createdAt: row.createdAt,
        name: row.name,
        filename: row.filename,
        matchScore: row.matchScore,
        jobTitle: row.jobTitle ?? null,
      }));
    }

    return c.json({
      stats: {
        totalClients,
        totalCandidates,
        totalApplications,
        activeJobs,
        totalUsers,
      },
      myJobs,
      recentApplications,
    });
  } catch (error) {
    console.error('Dashboard error:', error);
    return c.json({ error: 'Failed to fetch dashboard metrics' }, 500);
  }
});

export default dashboardRouter;
