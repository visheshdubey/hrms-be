import { Hono } from 'hono';
import { db } from '../db/index.js';
import { jobs, candidates, users, applications, accounts } from '../db/schema.js';
import { eq, desc, and, or, sql, inArray } from 'drizzle-orm';
import { requireAuth, type AppContext } from '../middleware.js';

const dashboardRouter = new Hono<AppContext>({ strict: false });

dashboardRouter.get('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId  = c.get('organizationId') as number | null;

    let memberIds: number[] = [userId];
    if (orgId != null) {
      const orgMembers = await db.select({ id: users.id }).from(users).where(eq(users.organizationId, orgId));
      memberIds = orgMembers.map((u) => u.id);
    }

    // --- Stats ---

    const totalClients = orgId != null
      ? (await db.select({ cnt: sql<number>`count(*)` }).from(accounts).where(eq(accounts.organizationId, orgId)))[0]?.cnt ?? 0
      : 0;

    const totalCandidates = memberIds.length === 1
      ? (await db.select({ cnt: sql<number>`count(*)` }).from(candidates).where(eq(candidates.createdBy, userId)))[0]?.cnt ?? 0
      : (await db.select({ cnt: sql<number>`count(*)` }).from(candidates).where(inArray(candidates.createdBy, memberIds)))[0]?.cnt ?? 0;

    const totalApplications = memberIds.length === 1
      ? (await db.select({ cnt: sql<number>`count(*)` }).from(applications).where(eq(applications.createdBy, userId)))[0]?.cnt ?? 0
      : (await db.select({ cnt: sql<number>`count(*)` }).from(applications).where(inArray(applications.createdBy, memberIds)))[0]?.cnt ?? 0;

    const activeJobsWhere = memberIds.length === 1
      ? and(eq(jobs.status, 'submission_in_progress'), eq(jobs.createdBy, userId))
      : and(eq(jobs.status, 'submission_in_progress'), inArray(jobs.createdBy, memberIds));
    const activeJobs = (await db.select({ cnt: sql<number>`count(*)` }).from(jobs).where(activeJobsWhere))[0]?.cnt ?? 0;

    const totalUsers = orgId != null
      ? (await db.select({ cnt: sql<number>`count(*)` }).from(users).where(and(eq(users.organizationId, orgId), eq(users.isActive, 1))))[0]?.cnt ?? 0
      : 1;

    // --- My Jobs (assigned to or created by current user) ---

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
      .where(or(eq(jobs.createdBy, userId), eq(jobs.assignedTo, userId)))
      .orderBy(desc(jobs.id))
      .limit(20);

    const myJobs = myJobsRows.map((row) => ({
      id: row.id,
      title: row.title,
      department: row.department,
      location: row.location,
      status: row.status,
      applicants: row.applicants ?? 0,
      accountId: row.accountId ?? null,
      accountName: row.accountName ?? '',
    }));

    // --- Recent Applications (latest 10 across org) ---

    const appWhere = memberIds.length === 1
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

    const recentApplications = recentAppRows.map((row) => ({
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

    return c.json({
      stats: {
        totalClients: Number(totalClients),
        totalCandidates: Number(totalCandidates),
        totalApplications: Number(totalApplications),
        activeJobs: Number(activeJobs),
        totalUsers: Number(totalUsers),
      },
      myJobs,
      recentApplications,
    });
  } catch (error) {
    console.error("Dashboard error:", error);
    return c.json({ error: 'Failed to fetch dashboard metrics' }, 500);
  }
});

export default dashboardRouter;
