import { Hono } from 'hono';
import { db } from '../db/index.js';
import { accounts, jobs, candidates, users, applications, interviews, APP_STATUSES } from '../db/schema.js';
import { eq, desc, and, or, sql, gte, inArray } from 'drizzle-orm';
import { requireAuth, type AppContext } from '../middleware.js';
import { getOrgMemberIds, orgOrCreatorScope } from '../lib/orgScope.js';
import { isSchemaDriftError } from '../lib/schemaDrift.js';

const dashboardRouter = new Hono<AppContext>({ strict: false });

const STAGE_LABELS: Record<typeof APP_STATUSES[number], string> = {
  applied: 'Applied',
  in_review: 'In Review',
  shortlisted: 'Shortlisted',
  rejected: 'Rejected',
  interview_scheduled: 'Interview Scheduled',
  hold: 'Hold',
  offer: 'Offer',
  no_offer: 'No Offer',
};

/**
 * Returns an ISO date string for the start of the requested period.
 * period: "7d" | "30d" | "90d" | "12m" (default)
 */
function periodToSince(period: string | undefined): string | null {
  const now = new Date();
  switch (period) {
    case '24h': { now.setHours(now.getHours() - 24); return now.toISOString(); }
    case '7d':  { now.setDate(now.getDate() - 7);    return now.toISOString(); }
    case '30d': { now.setDate(now.getDate() - 30);   return now.toISOString(); }
    case '90d': { now.setDate(now.getDate() - 90);   return now.toISOString(); }
    case '12m': { now.setFullYear(now.getFullYear() - 1); return now.toISOString(); }
    default:    return null;
  }
}

/**
 * Decide how many buckets to show and the SQLite strftime format for the period.
 */
function myJobsWhere(orgId: number | null, userId: number, memberIds: number[]) {
  const personalScope = or(eq(jobs.assignedTo, userId), eq(jobs.createdBy, userId))!;
  if (orgId == null) return personalScope;
  return and(personalScope, inArray(jobs.createdBy, memberIds))!;
}

function chartConfig(period: string | undefined): {
  fmt: string; count: number; labelFn: (d: Date) => string;
} {
  const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  switch (period) {
    case '24h':
      return { fmt: '%H', count: 24, labelFn: (d) => `${d.getHours()}:00` };
    case '7d':
      return { fmt: '%Y-%m-%d', count: 7,  labelFn: (d) => d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}) };
    case '30d':
      return { fmt: '%Y-%m-%d', count: 30, labelFn: (d) => `${monthNames[d.getMonth()]} ${d.getDate()}` };
    case '90d':
      return { fmt: '%Y-%m-%d', count: 90, labelFn: (d) => `${monthNames[d.getMonth()]} ${d.getDate()}` };
    default:   // 12m
      return { fmt: '%m', count: 12, labelFn: (d) => monthNames[d.getMonth()] };
  }
}

dashboardRouter.get('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId  = c.get('organizationId') as number | null;
    const period = c.req.query('period');
    const since  = periodToSince(period);

    const memberIds = await getOrgMemberIds(orgId, userId);

    const appWhere = memberIds.length === 1
      ? (since ? and(eq(applications.createdBy, userId), gte(applications.createdAt, since)) : eq(applications.createdBy, userId))
      : (since ? and(inArray(applications.createdBy, memberIds), gte(applications.createdAt, since)) : inArray(applications.createdBy, memberIds));

    const allApplications = await db.select().from(applications).where(appWhere);
    const totalApplications = allApplications.length;

    const jobsWhere = memberIds.length === 1
      ? and(eq(jobs.status, 'submission_in_progress'), eq(jobs.createdBy, userId))
      : and(eq(jobs.status, 'submission_in_progress'), inArray(jobs.createdBy, memberIds));
    const activeJobsQuery = await db.select().from(jobs).where(jobsWhere);
    const activeJobs = activeJobsQuery.length;

    const candidateWhere = memberIds.length === 1
      ? eq(candidates.createdBy, userId)
      : inArray(candidates.createdBy, memberIds);
    const candidateCountRows = await db
      .select({ count: sql<number>`count(*)` })
      .from(candidates)
      .where(candidateWhere);
    const totalCandidates = Number(candidateCountRows[0]?.count ?? 0);

    let totalClients = 0;
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

    const totalUsers = memberIds.length;

    const myJobsRaw = await db
      .select({
        id: jobs.id,
        title: jobs.title,
        department: jobs.department,
        location: jobs.location,
        status: jobs.status,
        applicants: jobs.applicants,
        accountId: jobs.accountId,
      })
      .from(jobs)
      .where(myJobsWhere(orgId, userId, memberIds))
      .orderBy(desc(jobs.id))
      .limit(10);

    const accountIdsForJobs = [
      ...new Set(myJobsRaw.map((row) => row.accountId).filter((id): id is number => id != null)),
    ];
    const accountNameMap = new Map<number, string>();
    if (accountIdsForJobs.length > 0) {
      const accountRows = await db
        .select({ id: accounts.id, name: accounts.name })
        .from(accounts)
        .where(inArray(accounts.id, accountIdsForJobs));
      accountRows.forEach((row) => accountNameMap.set(row.id, row.name));
    }

    const myJobs = myJobsRaw.map((row) => ({
      id: row.id,
      title: row.title,
      department: row.department ?? 'General',
      location: row.location ?? 'Remote',
      status: row.status,
      applicants: row.applicants ?? 0,
      accountId: row.accountId,
      accountName: row.accountId != null ? (accountNameMap.get(row.accountId) ?? '') : '',
    }));

    const recentActivity = await db
      .select({
        id: applications.id,
        applicationId: applications.id,
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
      .leftJoin(jobs, eq(applications.jobId, jobs.id))
      .where(appWhere)
      .orderBy(desc(applications.createdAt))
      .limit(10);

    const pipelineDataRaw = await db
      .select({
        stage: applications.status,
        count: sql<number>`count(${applications.id})`,
      })
      .from(applications)
      .where(appWhere)
      .groupBy(applications.status);

    const stagesMap: Record<string, number> = {};
    for (const status of APP_STATUSES) {
      stagesMap[STAGE_LABELS[status]] = 0;
    }
    pipelineDataRaw.forEach((row) => {
      const label = STAGE_LABELS[row.stage as typeof APP_STATUSES[number]] ?? row.stage;
      if (label) stagesMap[label] = row.count;
    });

    const pipelineByStage = Object.entries(stagesMap)
      .map(([name, count]) => ({ name, count }))
      .filter((x) => x.count > 0 || ['Applied', 'Shortlisted', 'Interview Scheduled'].includes(x.name));

    const { fmt, count: bucketCount, labelFn } = chartConfig(period);

    const rawBuckets = await db
      .select({
        bucket: sql<string>`strftime(${fmt}, ${applications.createdAt})`,
        count:  sql<number>`count(${applications.id})`,
      })
      .from(applications)
      .where(appWhere)
      .groupBy(sql`strftime(${fmt}, ${applications.createdAt})`);

    const bucketMap: Record<string, number> = {};
    rawBuckets.forEach((r) => { if (r.bucket) bucketMap[r.bucket] = r.count; });

    const applicationsOverTime = [];
    for (let i = bucketCount - 1; i >= 0; i--) {
      const d = new Date();
      if (fmt === '%H') {
        d.setHours(d.getHours() - i, 0, 0, 0);
      } else if (fmt === '%m') {
        d.setDate(1);
        d.setMonth(d.getMonth() - i);
      } else {
        d.setDate(d.getDate() - i);
      }

      let key: string;
      if (fmt === '%H') {
        key = d.getHours().toString().padStart(2, '0');
      } else if (fmt === '%m') {
        key = (d.getMonth() + 1).toString().padStart(2, '0');
      } else {
        key = d.toISOString().slice(0, 10);
      }

      applicationsOverTime.push({
        month:   labelFn(d),
        current: bucketMap[key] ?? 0,
        previous: 0,
      });
    }

    const interviewWhere = memberIds.length === 1
      ? and(eq(interviews.status, 'scheduled'), eq(interviews.createdBy, userId))
      : and(eq(interviews.status, 'scheduled'), inArray(interviews.createdBy, memberIds));
    const scheduledInterviews = await db.select().from(interviews).where(interviewWhere);

    return c.json({
      stats: {
        totalClients,
        totalCandidates,
        totalApplications,
        activeJobs,
        totalUsers,
      },
      myJobs,
      recentApplications: recentActivity,
      totalCandidates: totalApplications,
      activeJobs,
      interviewsScheduled: scheduledInterviews.length,
      recentActivity,
      pipelineByStage,
      applicationsOverTime,
    });
  } catch (error) {
    console.error("Dashboard error:", error);
    return c.json({ error: 'Failed to fetch dashboard metrics' }, 500);
  }
});

export default dashboardRouter;
