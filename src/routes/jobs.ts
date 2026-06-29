import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import { eq, desc, inArray, and } from 'drizzle-orm';
import { requireAuth, type AppContext } from '../middleware.js';
import { jobs, users, jobStages, JOB_STAGE_TYPES } from '../db/schema.js';

const jobsRouter = new Hono<AppContext>({ strict: false });

type JobStatus = 'new' | 'draft' | 'ready' | 'submission_in_progress' | 'closed';

/** Allowed forward/backward transitions per the Phase 2 lifecycle spec */
const TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  new:                    ['draft'],
  draft:                  ['ready'],
  ready:                  ['draft', 'submission_in_progress'],
  submission_in_progress: ['closed'],
  closed:                 [],
};

const jobSchema = z.object({
  title: z.string().min(1, "Title is required"),
  department: z.string().optional(),
  status: z.enum(["new", "draft", "ready", "submission_in_progress", "closed"]).optional(),
  type: z.enum(["Full-time", "Part-time", "Contract"]).optional(),
  location: z.enum(["Remote", "On-site", "Hybrid"]).optional(),
  description: z.string().optional(),
  accountId: z.number().int().positive().optional().nullable(),
  payPackageMin: z.number().nonnegative().optional().nullable(),
  payPackageMax: z.number().nonnegative().optional().nullable(),
  payCurrency: z.string().optional(),
});

const stageSchema = z.object({
  name: z.string().min(1),
  orderIndex: z.number().int().nonnegative().optional(),
  stageType: z.enum(JOB_STAGE_TYPES).optional(),
});

const statusSchema = z.object({
  status: z.enum(["new", "draft", "ready", "submission_in_progress", "closed"]),
});

// GET /jobs — list all jobs visible to the authenticated user's organization
jobsRouter.get('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const accountIdParam = c.req.query('accountId');

    let all;
    if (orgId != null) {
      const orgMembers = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.organizationId, orgId));

      const memberIds = orgMembers.map((u: { id: number }) => u.id);
      if (memberIds.length === 0) return c.json([]);

      all = await db
        .select()
        .from(jobs)
        .where(inArray(jobs.createdBy, memberIds))
        .orderBy(desc(jobs.id));
    } else {
      all = await db
        .select()
        .from(jobs)
        .where(eq(jobs.createdBy, userId))
        .orderBy(desc(jobs.id));
    }

    if (accountIdParam) {
      const accountId = parseInt(accountIdParam);
      if (!isNaN(accountId)) {
        all = all.filter((j) => j.accountId === accountId);
      }
    }

    const now = Date.now();
    const result = all.map((j: any) => ({
      ...j,
      skills: j.description,
      postedDate: formatRelativeTime(j.postedDate, now),
    }));
    return c.json(result);
  } catch {
    return c.json({ error: 'Failed to fetch jobs' }, 500);
  }
});

// GET /jobs/:id — single job detail
jobsRouter.get('/:id', requireAuth, async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const row = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
    if (row.length === 0) return c.json({ error: 'Job not found' }, 404);

    const j = row[0];
    return c.json({
      ...j,
      skills: j.description,
      postedDate: formatRelativeTime(j.postedDate, Date.now()),
      allowedTransitions: TRANSITIONS[j.status as JobStatus] ?? [],
    });
  } catch {
    return c.json({ error: 'Failed to fetch job' }, 500);
  }
});

// POST /jobs — create (defaults to 'new')
jobsRouter.post('/', requireAuth, zValidator('json', jobSchema), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const body = c.req.valid('json');
    const { title, department, status, type, location, description } = body;

    const created = await db.insert(jobs).values({
      title,
      department: department || 'General',
      status: status || 'new',
      type: type || 'Full-time',
      location: location || 'Remote',
      description: description || '',
      accountId: body.accountId ?? null,
      payPackageMin: body.payPackageMin ?? null,
      payPackageMax: body.payPackageMax ?? null,
      payCurrency: body.payCurrency ?? 'INR',
      applicants: 0,
      createdBy: userId,
    }).returning();

    return c.json(created[0], 201);
  } catch {
    return c.json({ error: 'Failed to create job' }, 500);
  }
});

// PATCH /jobs/:id/status — explicit lifecycle transition
jobsRouter.patch('/:id/status', requireAuth, zValidator('json', statusSchema), async (c) => {
  try {
    const orgId = c.get('organizationId') as number | null;
    const userId = c.get('userId') as number;
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const { status: nextStatus } = c.req.valid('json');

    const row = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
    if (row.length === 0) return c.json({ error: 'Job not found' }, 404);

    // Org-scope check: the job must belong to the caller's org (or be their own)
    if (orgId != null) {
      const orgMembers = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.organizationId, orgId));
      const memberIds = orgMembers.map((u: any) => u.id);
      if (!memberIds.includes(row[0].createdBy!)) {
        return c.json({ error: 'Job not found or unauthorized' }, 403);
      }
    } else if (row[0].createdBy !== userId) {
      return c.json({ error: 'Job not found or unauthorized' }, 403);
    }

    const currentStatus = row[0].status as JobStatus;
    const allowed = TRANSITIONS[currentStatus] ?? [];

    if (!allowed.includes(nextStatus as JobStatus)) {
      return c.json({
        error: `Invalid transition: ${currentStatus} → ${nextStatus}`,
        allowedTransitions: allowed,
      }, 400);
    }

    const updated = await db.update(jobs)
      .set({ status: nextStatus })
      .where(eq(jobs.id, id))
      .returning();

    return c.json({
      ...updated[0],
      allowedTransitions: TRANSITIONS[nextStatus as JobStatus] ?? [],
    });
  } catch {
    return c.json({ error: 'Failed to update job status' }, 500);
  }
});

// PUT /jobs/:id — full update
jobsRouter.put('/:id', requireAuth, zValidator('json', jobSchema), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const id = parseInt(c.req.param('id'));
    const body = c.req.valid('json');

    const existing = await db.select().from(jobs).where(eq(jobs.id, id));
    if (existing.length === 0 || existing[0].createdBy !== userId) {
      return c.json({ error: 'Job not found or unauthorized' }, 403);
    }

    const patch: Record<string, unknown> = {};
    for (const k of ['title','department','status','type','location','description','accountId','payPackageMin','payPackageMax','payCurrency'] as const) {
      if (body[k] !== undefined) patch[k] = body[k];
    }

    const updated = await db.update(jobs)
      .set(patch as typeof jobs.$inferInsert)
      .where(eq(jobs.id, id))
      .returning();

    if (updated.length === 0) return c.json({ error: 'Job not found' }, 404);
    return c.json(updated[0]);
  } catch {
    return c.json({ error: 'Failed to update job' }, 500);
  }
});

// DELETE /jobs/:id
jobsRouter.delete('/:id', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const id = parseInt(c.req.param('id'));

    const existing = await db.select().from(jobs).where(eq(jobs.id, id));
    if (existing.length === 0 || existing[0].createdBy !== userId) {
      return c.json({ error: 'Job not found or unauthorized' }, 403);
    }

    await db.delete(jobs).where(eq(jobs.id, id));
    return c.json({ message: 'Job deleted' });
  } catch {
    return c.json({ error: 'Failed to delete job' }, 500);
  }
});

// GET /jobs/:jobId/stages
jobsRouter.get('/:jobId/stages', requireAuth, async (c) => {
  try {
    const jobId = parseInt(c.req.param('jobId'));
    if (isNaN(jobId)) return c.json({ error: 'Invalid job id' }, 400);

    const stages = await db.select().from(jobStages)
      .where(eq(jobStages.jobId, jobId))
      .orderBy(jobStages.orderIndex);
    return c.json({ data: stages });
  } catch {
    return c.json({ error: 'Failed to fetch job stages' }, 500);
  }
});

// POST /jobs/:jobId/stages
jobsRouter.post('/:jobId/stages', requireAuth, zValidator('json', stageSchema), async (c) => {
  try {
    const jobId = parseInt(c.req.param('jobId'));
    if (isNaN(jobId)) return c.json({ error: 'Invalid job id' }, 400);

    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (!job) return c.json({ error: 'Job not found' }, 404);

    const b = c.req.valid('json');
    const [created] = await db.insert(jobStages).values({
      jobId,
      name: b.name,
      orderIndex: b.orderIndex ?? 0,
      stageType: b.stageType ?? 'application',
    }).returning();

    return c.json(created, 201);
  } catch {
    return c.json({ error: 'Failed to create job stage' }, 500);
  }
});

// PUT /jobs/:jobId/stages/:stageId
jobsRouter.put('/:jobId/stages/:stageId', requireAuth, zValidator('json', stageSchema.partial()), async (c) => {
  try {
    const jobId = parseInt(c.req.param('jobId'));
    const stageId = parseInt(c.req.param('stageId'));
    if (isNaN(jobId) || isNaN(stageId)) return c.json({ error: 'Invalid id' }, 400);

    const b = c.req.valid('json');
    const patch: Record<string, unknown> = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.orderIndex !== undefined) patch.orderIndex = b.orderIndex;
    if (b.stageType !== undefined) patch.stageType = b.stageType;

    const [updated] = await db.update(jobStages).set(patch as typeof jobStages.$inferInsert)
      .where(and(eq(jobStages.id, stageId), eq(jobStages.jobId, jobId)))
      .returning();
    if (!updated) return c.json({ error: 'Stage not found' }, 404);
    return c.json(updated);
  } catch {
    return c.json({ error: 'Failed to update job stage' }, 500);
  }
});

// DELETE /jobs/:jobId/stages/:stageId
jobsRouter.delete('/:jobId/stages/:stageId', requireAuth, async (c) => {
  try {
    const jobId = parseInt(c.req.param('jobId'));
    const stageId = parseInt(c.req.param('stageId'));
    if (isNaN(jobId) || isNaN(stageId)) return c.json({ error: 'Invalid id' }, 400);

    await db.delete(jobStages).where(and(eq(jobStages.id, stageId), eq(jobStages.jobId, jobId)));
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'Failed to delete job stage' }, 500);
  }
});

function formatRelativeTime(dateStr: string | null, now: number): string {
  if (!dateStr) return 'Just now';
  const diff = now - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days !== 1 ? 's' : ''} ago`;
}

export default jobsRouter;
