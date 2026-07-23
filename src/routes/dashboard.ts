import { Hono, type Context } from 'hono';
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
import {
  buildBenchSalesStats,
  buildByMember,
  buildConversion,
  buildDrilldown,
  buildRecruitmentStats,
  parseDateRange,
  parseIdList,
  parseOptionalAccountIds,
  type AnalyticsFilters,
  type MetricKey,
} from '../lib/dashboardAnalytics.js';

const dashboardRouter = new Hono<AppContext>({ strict: false });

const METRIC_KEYS = new Set<MetricKey>([
  'jobs',
  'candidates',
  'submissions',
  'endClientSubmissions',
  'interviews',
  'confirmations',
  'offers',
  'placements',
  'dropouts',
  'deferred',
  'poolAdded',
  'activePool',
  'poolNoSubmissions',
  'poolWithSubmissions',
  'poolPlaced',
  'hotlist',
  'poolInterviews',
]);

async function resolveAnalyticsContext(c: Context<AppContext>) {
  const userId = c.get('userId') as number;
  const orgId = c.get('organizationId') as number | null;
  const role = c.get('userRole') as UserRole | null;

  if (isOrgPortalRole(role)) {
    return { error: true as const, response: c.json({ error: 'Analytics dashboard is available for recruiter portal only' }, 403) };
  }

  const memberIds = await getOrgMemberIds(orgId, userId);
  const accessibleAccounts = await getAccessibleAccountIds(userId, orgId, role);
  const { fromStart, toExclusive, prevFromStart, prevToExclusive } = parseDateRange(
    c.req.query('from') ?? undefined,
    c.req.query('to') ?? undefined,
  );
  const userIds = parseIdList(c.req.query('userIds') ?? undefined, memberIds);
  const accountIds = parseOptionalAccountIds(c.req.query('accountIds') ?? undefined, accessibleAccounts);
  const groupBy = (c.req.query('groupBy') === 'team' ? 'team' : 'user') as 'user' | 'team';

  const current: AnalyticsFilters = {
    fromStart,
    toExclusive,
    userIds,
    accountIds,
    memberIds,
  };
  const previous: AnalyticsFilters = {
    fromStart: prevFromStart,
    toExclusive: prevToExclusive,
    userIds,
    accountIds,
    memberIds,
  };

  return { error: false as const, orgId, memberIds, accessibleAccounts, current, previous, groupBy, userId };
}

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
          filename: '',
          matchScore: null,
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

dashboardRouter.get('/analytics', requireAuth, async (c) => {
  try {
    const ctx = await resolveAnalyticsContext(c);
    if (ctx.error) return ctx.response;

    const { orgId, current, previous, groupBy, memberIds, accessibleAccounts } = ctx;

    const [recruitment, benchSales, conversion, byMember] = await Promise.all([
      buildRecruitmentStats(current, previous),
      buildBenchSalesStats(current, previous),
      buildConversion(current),
      buildByMember(current, groupBy, orgId),
    ]);

    const orgUsers = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, memberIds));

    const clientRows =
      accessibleAccounts.length > 0
        ? await db
            .select({ id: accounts.id, name: accounts.name })
            .from(accounts)
            .where(inArray(accounts.id, accessibleAccounts))
        : [];

    return c.json({
      range: {
        from: current.fromStart,
        to: addDaysIso(current.toExclusive, -1),
        previousFrom: previous.fromStart,
        previousTo: addDaysIso(previous.toExclusive, -1),
      },
      filters: {
        userIds: current.userIds,
        accountIds: current.accountIds,
        groupBy,
      },
      recruitment,
      benchSales,
      conversion,
      byMember,
      meta: {
        users: orgUsers,
        clients: clientRows,
      },
    });
  } catch (error) {
    console.error('Dashboard analytics error:', error);
    return c.json({ error: 'Failed to fetch dashboard analytics' }, 500);
  }
});

dashboardRouter.get('/analytics/drilldown', requireAuth, async (c) => {
  try {
    const ctx = await resolveAnalyticsContext(c);
    if (ctx.error) return ctx.response;

    const metricRaw = (c.req.query('metric') ?? '') as MetricKey;
    if (!METRIC_KEYS.has(metricRaw)) {
      return c.json({ error: 'Invalid metric' }, 400);
    }

    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));
    const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0);

    const scopeUserId = Number(c.req.query('scopeUserId') ?? 0);
    const filters: AnalyticsFilters = { ...ctx.current };
    if (Number.isFinite(scopeUserId) && scopeUserId > 0 && ctx.memberIds.includes(scopeUserId)) {
      filters.userIds = [scopeUserId];
    }

    const { rows, total } = await buildDrilldown(metricRaw, filters, limit, offset);
    return c.json({ metric: metricRaw, total, limit, offset, rows });
  } catch (error) {
    console.error('Dashboard drilldown error:', error);
    return c.json({ error: 'Failed to fetch drilldown' }, 500);
  }
});

function addDaysIso(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default dashboardRouter;
