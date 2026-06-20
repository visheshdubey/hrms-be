import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import {
  applications,
  applicationStageHistory,
  candidates,
  jobs,
  users,
  savedReports,
  APP_STATUSES,
} from '../db/schema.js';
import { eq, inArray, sql, desc } from 'drizzle-orm';
import { requireAuth, type AppContext } from '../middleware.js';
import { STATUS_LABELS } from './applications.js';

const reportsRouter = new Hono<AppContext>({ strict: false });

async function getOrgMemberIds(userId: number, orgId: number | null): Promise<number[]> {
  if (orgId == null) return [userId];
  const members = await db.select({ id: users.id }).from(users).where(eq(users.organizationId, orgId));
  return members.map((u: { id: number }) => u.id);
}

async function getOrgJobIds(memberIds: number[]): Promise<number[]> {
  if (memberIds.length === 0) return [];
  const rows = await db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.createdBy, memberIds));
  return rows.map((r: { id: number }) => r.id);
}

function safeJsonParse(str: string | null): Record<string, unknown> {
  try { return JSON.parse(str || '{}'); } catch { return {}; }
}

/* GET /reports/summary */
reportsRouter.get('/summary', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const memberIds = await getOrgMemberIds(userId, orgId);
    const jobIds = await getOrgJobIds(memberIds);

    if (jobIds.length === 0) {
      return c.json({
        totalApplications: 0,
        byStatus: [],
        timeToHireDays: 0,
        offersExtended: 0,
        sourceBreakdown: { pool: 0, jobLinked: 0, upload: 0 },
      });
    }

    const apps = await db.select().from(applications).where(inArray(applications.jobId, jobIds));

    const statusCounts: Record<string, number> = {};
    for (const s of APP_STATUSES) statusCounts[s] = 0;
    apps.forEach((a: { status: string }) => { statusCounts[a.status] = (statusCounts[a.status] ?? 0) + 1; });

    const byStatus = Object.entries(statusCounts)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => ({
        status,
        label: STATUS_LABELS[status as keyof typeof STATUS_LABELS] ?? status,
        count,
      }));

    // Time-to-hire: avg days from application created → first 'offer' in history
    const offerApps = apps.filter((a: { status: string }) => a.status === 'offer');
    let totalDays = 0;
    let hireCount = 0;

    for (const app of offerApps) {
      const [offerRow] = await db
        .select({ changedAt: applicationStageHistory.changedAt })
        .from(applicationStageHistory)
        .where(
          sql`${applicationStageHistory.applicationId} = ${app.id} AND ${applicationStageHistory.toStatus} = 'offer'`
        )
        .orderBy(desc(applicationStageHistory.changedAt))
        .limit(1);

      if (offerRow?.changedAt && app.createdAt) {
        const days = (new Date(offerRow.changedAt).getTime() - new Date(app.createdAt).getTime()) / 86400000;
        if (days >= 0) { totalDays += days; hireCount++; }
      }
    }

    // Source breakdown from candidates table
    const candWhere = memberIds.length === 1
      ? eq(candidates.createdBy, userId)
      : inArray(candidates.createdBy, memberIds);
    const allCands = await db.select({ jobId: candidates.jobId, filename: candidates.filename }).from(candidates).where(candWhere);

    const sourceBreakdown = {
      pool:      allCands.filter((c: { jobId: number | null }) => !c.jobId).length,
      jobLinked: allCands.filter((c: { jobId: number | null }) => !!c.jobId).length,
      upload:    allCands.filter((c: { filename: string }) => c.filename && c.filename !== 'unknown.pdf').length,
    };

    return c.json({
      totalApplications: apps.length,
      byStatus,
      timeToHireDays: hireCount > 0 ? Math.round(totalDays / hireCount) : 0,
      offersExtended: offerApps.length,
      sourceBreakdown,
    });
  } catch (err) {
    console.error('Reports summary error:', err);
    return c.json({ error: 'Failed to fetch report summary' }, 500);
  }
});

/* GET /reports/pipeline */
reportsRouter.get('/pipeline', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const memberIds = await getOrgMemberIds(userId, orgId);
    const jobIds = await getOrgJobIds(memberIds);

    if (jobIds.length === 0) return c.json({ jobs: [], stages: [] });

    const orgJobs = await db.select({ id: jobs.id, title: jobs.title, department: jobs.department })
      .from(jobs).where(inArray(jobs.id, jobIds));

    const pipeline = await Promise.all(orgJobs.map(async (job: { id: number; title: string; department: string }) => {
      const rows = await db
        .select({ status: applications.status, count: sql<number>`count(${applications.id})` })
        .from(applications)
        .where(eq(applications.jobId, job.id))
        .groupBy(applications.status);

      const stages = rows.map((r: { status: string; count: number }) => ({
        status: r.status,
        label: STATUS_LABELS[r.status as keyof typeof STATUS_LABELS] ?? r.status,
        count: r.count,
      }));

      const total = stages.reduce((sum: number, s: { count: number }) => sum + s.count, 0);
      return { jobId: job.id, title: job.title, department: job.department, total, stages };
    }));

    const globalStages = await db
      .select({ status: applications.status, count: sql<number>`count(${applications.id})` })
      .from(applications)
      .where(inArray(applications.jobId, jobIds))
      .groupBy(applications.status);

    return c.json({
      jobs: pipeline,
      stages: globalStages.map((r: { status: string; count: number }) => ({
        status: r.status,
        label: STATUS_LABELS[r.status as keyof typeof STATUS_LABELS] ?? r.status,
        count: r.count,
      })),
    });
  } catch {
    return c.json({ error: 'Failed to fetch pipeline report' }, 500);
  }
});

/* GET /reports/export — CSV download */
reportsRouter.get('/export', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const memberIds = await getOrgMemberIds(userId, orgId);
    const jobIds = await getOrgJobIds(memberIds);

    if (jobIds.length === 0) {
      return c.json({ error: 'No data to export' }, 404);
    }

    const rows = await db
      .select({
        appId: applications.id,
        status: applications.status,
        createdAt: applications.createdAt,
        jobTitle: jobs.title,
        department: jobs.department,
        candidateName: candidates.name,
        candidateEmail: candidates.email,
        matchScore: candidates.matchScore,
      })
      .from(applications)
      .innerJoin(jobs, eq(applications.jobId, jobs.id))
      .innerJoin(candidates, eq(applications.candidateId, candidates.id))
      .where(inArray(applications.jobId, jobIds))
      .orderBy(desc(applications.createdAt));

    const headers = ['Application ID', 'Job', 'Department', 'Candidate', 'Email', 'Match Score', 'Status', 'Applied Date'];
    const csvRows = rows.map((r: {
      appId: number; jobTitle: string; department: string;
      candidateName: string; candidateEmail: string; matchScore: number;
      status: string; createdAt: string;
    }) => [
      r.appId,
      `"${(r.jobTitle || '').replace(/"/g, '""')}"`,
      `"${(r.department || '').replace(/"/g, '""')}"`,
      `"${(r.candidateName || '').replace(/"/g, '""')}"`,
      `"${(r.candidateEmail || '').replace(/"/g, '""')}"`,
      r.matchScore,
      r.status,
      r.createdAt,
    ].join(','));

    const csv = [headers.join(','), ...csvRows].join('\n');
    return c.text(csv, 200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="pipeline_report.csv"',
    });
  } catch {
    return c.json({ error: 'Failed to export report' }, 500);
  }
});

const savedSchema = z.object({
  name: z.string().min(1),
  type: z.string().optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
});

/* GET /reports/saved */
reportsRouter.get('/saved', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const rows = await db.select().from(savedReports)
      .where(eq(savedReports.userId, userId))
      .orderBy(desc(savedReports.createdAt));

    return c.json(rows.map((r: { filters: string | null; [k: string]: unknown }) => ({
      ...r,
      filters: safeJsonParse(r.filters),
    })));
  } catch {
    return c.json({ error: 'Failed to fetch saved reports' }, 500);
  }
});

/* POST /reports/saved */
reportsRouter.post('/saved', requireAuth, zValidator('json', savedSchema), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const body = c.req.valid('json');

    const [created] = await db.insert(savedReports).values({
      userId,
      name: body.name,
      type: body.type ?? 'pipeline',
      filters: JSON.stringify(body.filters ?? {}),
    }).returning();

    return c.json({ ...created, filters: safeJsonParse(created.filters) }, 201);
  } catch {
    return c.json({ error: 'Failed to save report' }, 500);
  }
});

/* PUT /reports/saved/:id */
reportsRouter.put('/saved/:id', requireAuth, zValidator('json', savedSchema.partial()), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const existing = await db.select().from(savedReports).where(eq(savedReports.id, id)).limit(1);
    if (!existing.length) return c.json({ error: 'Report not found' }, 404);
    if (existing[0].userId !== userId) return c.json({ error: 'Unauthorized' }, 403);

    const body = c.req.valid('json');
    const patch: Record<string, unknown> = {};
    if (body.name != null) patch.name = body.name;
    if (body.type != null) patch.type = body.type;
    if (body.filters != null) patch.filters = JSON.stringify(body.filters);

    const [updated] = await db.update(savedReports).set(patch as any).where(eq(savedReports.id, id)).returning();
    return c.json({ ...updated, filters: safeJsonParse(updated.filters) });
  } catch {
    return c.json({ error: 'Failed to update saved report' }, 500);
  }
});

/* DELETE /reports/saved/:id */
reportsRouter.delete('/saved/:id', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const existing = await db.select().from(savedReports).where(eq(savedReports.id, id)).limit(1);
    if (!existing.length) return c.json({ error: 'Report not found' }, 404);
    if (existing[0].userId !== userId) return c.json({ error: 'Unauthorized' }, 403);

    await db.delete(savedReports).where(eq(savedReports.id, id));
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'Failed to delete saved report' }, 500);
  }
});

export default reportsRouter;
