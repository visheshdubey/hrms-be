import { Hono } from 'hono';
import { db } from '../db/index.js';
import { jobs, candidates, users } from '../db/schema.js';
import { eq, desc, and, sql, gte, inArray } from 'drizzle-orm';
import { requireAuth, type AppContext } from '../middleware.js';

const dashboardRouter = new Hono<AppContext>({ strict: false });

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

    // Resolve org members for scoping
    let memberIds: number[] = [userId];
    if (orgId != null) {
      const orgMembers = await db.select({ id: users.id }).from(users).where(eq(users.organizationId, orgId));
      memberIds = orgMembers.map((u: any) => u.id);
    }

    const candWhere = memberIds.length === 1
      ? (since ? and(eq(candidates.createdBy, userId), gte(candidates.createdAt, since)) : eq(candidates.createdBy, userId))
      : (since ? and(inArray(candidates.createdBy, memberIds), gte(candidates.createdAt, since)) : inArray(candidates.createdBy, memberIds));

    // Total candidates (within period)
    const allCandidates = await db.select().from(candidates).where(candWhere);
    const totalCandidates = allCandidates.length;

    // Active jobs (no period filter — snapshot of current state)
    const jobsWhere = memberIds.length === 1
      ? and(eq(jobs.status, 'submission_in_progress'), eq(jobs.createdBy, userId))
      : and(eq(jobs.status, 'submission_in_progress'), inArray(jobs.createdBy, memberIds));
    const activeJobsQuery = await db.select().from(jobs).where(jobsWhere);
    const activeJobs = activeJobsQuery.length;

    // Recent activity (top 10, within period)
    const recentActivity = await db
      .select({
        id: candidates.id, name: candidates.name, filename: candidates.filename,
        matchScore: candidates.matchScore, createdAt: candidates.createdAt,
        jobId: candidates.jobId, status: candidates.status,
      })
      .from(candidates)
      .where(candWhere)
      .orderBy(desc(candidates.createdAt))
      .limit(10);

    // Pipeline by Stage (within period)
    const pipelineDataRaw = await db
      .select({
        stage: candidates.status,
        count: sql<number>`count(${candidates.id})`,
      })
      .from(candidates)
      .where(candWhere)
      .groupBy(candidates.status);

    const stagesMap: Record<string, number> = {
      'New': 0, 'Applied': 0, 'In Review': 0, 'Shortlisted': 0,
      'Rejected': 0, 'Interview Scheduled': 0, 'Hold': 0, 'Offer': 0, 'No Offer': 0,
    };
    pipelineDataRaw.forEach((row) => { if (row.stage) stagesMap[row.stage] = row.count; });

    const pipelineByStage = Object.entries(stagesMap)
      .map(([name, count]) => ({ name, count }))
      .filter(x => x.count > 0 || ['New', 'Applied', 'Shortlisted', 'Interview Scheduled'].includes(x.name));

    // Applications over time — bucketed by period
    const { fmt, count: bucketCount, labelFn } = chartConfig(period);

    const rawBuckets = await db
      .select({
        bucket: sql<string>`strftime(${fmt}, ${candidates.createdAt})`,
        count:  sql<number>`count(${candidates.id})`,
      })
      .from(candidates)
      .where(candWhere)
      .groupBy(sql`strftime(${fmt}, ${candidates.createdAt})`);

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

      // SQLite bucket key for this data point
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

    return c.json({
      totalCandidates,
      activeJobs,
      interviewsScheduled: stagesMap['Interview Scheduled'] ?? 0,
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
