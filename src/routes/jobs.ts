import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import { eq, desc, inArray, and, or, isNull, sql, type SQL } from 'drizzle-orm';
import { requireAuth, requireRole, ORG_ROLES, type AppContext, type UserRole } from '../middleware.js';
import { jobs, jobStages, JOB_STAGE_TYPES, applications, users, applicationStageHistory } from '../db/schema.js';
import {
  copyAccountStageTemplatesToJob,
  canWriteStageTemplates,
  getAccountIfAccessible,
  normalizeJobStageOrder,
} from '../lib/stages.js';
import {
  canAccessJob,
  getAccessibleAccountIds,
  getOrgMemberIds,
  isOrgPortalRole,
} from '../lib/orgScope.js';
import { defaultStageColor } from '../lib/stageColors.js';
import { backfillNullApplicationStages } from '../lib/applicationDefaults.js';
import { ensureApplicationHistoryStageColumns } from '../lib/application-history.js';

const jobsRouter = new Hono<AppContext>({ strict: false });

/** Core job columns present on older production DBs (excludes assigned_to). */
const LEGACY_JOB_SELECT = {
  id: jobs.id,
  title: jobs.title,
  department: jobs.department,
  status: jobs.status,
  type: jobs.type,
  location: jobs.location,
  applicants: jobs.applicants,
  description: jobs.description,
  postedDate: jobs.postedDate,
  accountId: jobs.accountId,
  payPackageMin: jobs.payPackageMin,
  payPackageMax: jobs.payPackageMax,
  payCurrency: jobs.payCurrency,
  createdBy: jobs.createdBy,
} as const;

const MINIMAL_JOB_SELECT = {
  id: jobs.id,
  title: jobs.title,
  department: jobs.department,
  status: jobs.status,
  type: jobs.type,
  location: jobs.location,
  applicants: jobs.applicants,
  description: jobs.description,
  postedDate: jobs.postedDate,
  accountId: jobs.accountId,
  createdBy: jobs.createdBy,
} as const;

function withJobDefaults<T extends Record<string, unknown>>(row: T) {
  return {
    ...row,
    assignedTo: null as number | null,
    payPackageMin: (row as { payPackageMin?: number | null }).payPackageMin ?? null,
    payPackageMax: (row as { payPackageMax?: number | null }).payPackageMax ?? null,
    payCurrency: (row as { payCurrency?: string | null }).payCurrency ?? 'INR',
  };
}

async function selectJobs(where?: SQL) {
  const run = async (columns?: Record<string, unknown>) => {
    const base = columns ? db.select(columns as any).from(jobs) : db.select().from(jobs);
    return where ? await base.where(where).orderBy(desc(jobs.id)) : await base.orderBy(desc(jobs.id));
  };

  try {
    return await run();
  } catch {
    try {
      const rows = await run(LEGACY_JOB_SELECT);
      return rows.map(withJobDefaults);
    } catch {
      const rows = await run(MINIMAL_JOB_SELECT);
      return rows.map(withJobDefaults);
    }
  }
}

async function selectJobById(id: number) {
  try {
    return await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  } catch {
    try {
      const rows = await db.select(LEGACY_JOB_SELECT).from(jobs).where(eq(jobs.id, id)).limit(1);
      return rows.map(withJobDefaults);
    } catch {
      const rows = await db.select(MINIMAL_JOB_SELECT).from(jobs).where(eq(jobs.id, id)).limit(1);
      return rows.map(withJobDefaults);
    }
  }
}

async function selectJobStages(jobId: number) {
  try {
    return await db
      .select()
      .from(jobStages)
      .where(eq(jobStages.jobId, jobId))
      .orderBy(jobStages.orderIndex);
  } catch {
    const rows = await db
      .select({
        id: jobStages.id,
        jobId: jobStages.jobId,
        name: jobStages.name,
        orderIndex: jobStages.orderIndex,
        stageType: jobStages.stageType,
        createdAt: jobStages.createdAt,
      })
      .from(jobStages)
      .where(eq(jobStages.jobId, jobId))
      .orderBy(jobStages.orderIndex);
    return rows.map((row, index) => ({
      ...row,
      color: defaultStageColor(index),
    }));
  }
}

type JobStatus =
  | "new"
  | "draft"
  | "ready"
  | "on_hold"
  | "submission_in_progress"
  | "complete"
  | "closed";

const JOB_STATUS_VALUES = [
  "new",
  "draft",
  "ready",
  "on_hold",
  "submission_in_progress",
  "complete",
  "closed",
] as const;

/** Allowed forward/backward transitions — Details edit can also set status via PUT. */
const TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  new: ["draft", "on_hold"],
  draft: ["on_hold", "submission_in_progress"],
  ready: ["draft", "on_hold", "submission_in_progress"],
  on_hold: ["draft", "submission_in_progress", "closed"],
  submission_in_progress: ["on_hold", "complete", "closed"],
  complete: ["closed"],
  closed: [],
};

const jobSchema = z.object({
  title: z.string().min(1, "Title is required"),
  department: z.string().optional(),
  status: z.enum(JOB_STATUS_VALUES).optional(),
  type: z.enum(["Full-time", "Part-time", "Contract"]).optional(),
  location: z.enum(["Remote", "On-site", "Hybrid"]).optional(),
  description: z.string().optional(),
  accountId: z.number().int().positive().optional().nullable(),
  payPackageMin: z.number().nonnegative().optional().nullable(),
  payPackageMax: z.number().nonnegative().optional().nullable(),
  payCurrency: z.string().optional(),
  assignedTo: z.number().int().positive().optional().nullable(),
});

const stageSchema = z.object({
  name: z.string().min(1),
  orderIndex: z.number().int().nonnegative().optional(),
  stageType: z.enum(JOB_STAGE_TYPES).optional(),
  color: z.string().min(4).max(32).optional(),
});

const reorderStagesSchema = z.object({
  stageIds: z.array(z.number().int().positive()).min(1),
});

const statusSchema = z.object({
  status: z.enum(JOB_STATUS_VALUES),
});

async function canAccessJobForStages(params: {
  jobId: number;
  userId: number;
  orgId: number | null;
  role?: UserRole | null;
}) {
  const { jobId, userId, orgId, role } = params;
  const [job] = await selectJobById(jobId);
  if (!job) return null;
  if (!await canAccessJob(job, userId, orgId, role)) return null;
  return job;
}

/** Prefer live application counts over denormalized `jobs.applicants` (seed can drift). */
async function attachRealApplicantCounts<T extends { id: number }>(rows: T[]): Promise<(T & { applicants: number })[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const counts = await db
    .select({
      jobId: applications.jobId,
      count: sql<number>`cast(count(*) as int)`,
    })
    .from(applications)
    .where(inArray(applications.jobId, ids))
    .groupBy(applications.jobId);
  const map = new Map(counts.map((c) => [c.jobId, Number(c.count)]));
  return rows.map((r) => ({ ...r, applicants: map.get(r.id) ?? 0 }));
}

// GET /jobs — recruiters: all agency jobs; org portal: only linked client account jobs
jobsRouter.get('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const accountIdParam = c.req.query('accountId');

    let all;
    try {
      if (orgId != null) {
        const accountIds = await getAccessibleAccountIds(userId, orgId, role);
        const orgPortal = isOrgPortalRole(role);

        if (orgPortal) {
          // Client users: only their account(s); orphan jobs only if they created them.
          if (accountIds.length === 0) {
            all = await selectJobs(and(isNull(jobs.accountId), eq(jobs.createdBy, userId)));
          } else {
            all = await selectJobs(
              or(
                inArray(jobs.accountId, accountIds),
                and(isNull(jobs.accountId), eq(jobs.createdBy, userId)),
              ),
            );
          }
        } else {
          const memberIds = await getOrgMemberIds(orgId, userId);
          if (accountIds.length === 0) {
            all = await selectJobs(and(isNull(jobs.accountId), inArray(jobs.createdBy, memberIds)));
          } else {
            all = await selectJobs(
              or(
                inArray(jobs.accountId, accountIds),
                and(isNull(jobs.accountId), inArray(jobs.createdBy, memberIds)),
              ),
            );
          }
        }
      } else {
        all = await selectJobs(eq(jobs.createdBy, userId));
      }
    } catch {
      // Last resort: never fall back to all org members for client portal users.
      if (isOrgPortalRole(role)) {
        all = await selectJobs(eq(jobs.createdBy, userId));
      } else {
        const memberIds = orgId != null ? await getOrgMemberIds(orgId, userId) : [userId];
        all = await selectJobs(inArray(jobs.createdBy, memberIds));
      }
    }

    if (accountIdParam) {
      const accountId = parseInt(accountIdParam);
      if (!isNaN(accountId)) {
        const allowed = await getAccessibleAccountIds(userId, orgId, role);
        if (!allowed.includes(accountId)) {
          return c.json({ error: 'Client account not found or unauthorized' }, 403);
        }
        all = all.filter((j) => j.accountId === accountId);
      }
    }

    const withCounts = await attachRealApplicantCounts(all as { id: number }[]);
    const now = Date.now();
    const result = withCounts.map((j: any) => ({
      ...j,
      skills: j.description,
      postedDate: formatRelativeTime(j.postedDate, now),
    }));
    return c.json(result);
  } catch (error) {
    console.error('[GET /jobs]', error);
    return c.json({ error: 'Failed to fetch jobs' }, 500);
  }
});

// GET /jobs/:id — single job detail
jobsRouter.get('/:id', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const row = await selectJobById(id);
    if (row.length === 0) return c.json({ error: 'Job not found' }, 404);

    if (!await canAccessJob(row[0], userId, orgId, role)) {
      return c.json({ error: 'Job not found' }, 404);
    }

    const j = row[0];
    let assignedToName: string | null = null;
    if (j.assignedTo != null) {
      const [assignee] = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, j.assignedTo))
        .limit(1);
      assignedToName = assignee?.name ?? null;
    }

    const [withCount] = await attachRealApplicantCounts([j]);
    return c.json({
      ...withCount,
      skills: j.description,
      postedDate: formatRelativeTime(j.postedDate, Date.now()),
      allowedTransitions: TRANSITIONS[j.status as JobStatus] ?? [],
      assignedToName,
    });
  } catch {
    return c.json({ error: 'Failed to fetch job' }, 500);
  }
});

// POST /jobs — create (client / org portal only)
jobsRouter.post('/', requireAuth, requireRole(...ORG_ROLES), zValidator('json', jobSchema), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const body = c.req.valid('json');
    const { title, department, status, type, location, description } = body;

    let accountId = body.accountId ?? null;
    const linkedIds = await getAccessibleAccountIds(userId, orgId, role);

    if (accountId != null) {
      const account = await getAccountIfAccessible(accountId, userId, orgId, role);
      if (!account) return c.json({ error: 'Client account not found or unauthorized' }, 403);
    } else if (linkedIds.length === 1) {
      accountId = linkedIds[0];
    } else if (linkedIds.length === 0) {
      return c.json({ error: 'No client account linked to your login. Contact your recruiter.' }, 400);
    } else {
      return c.json({ error: 'accountId is required when multiple client accounts are linked' }, 400);
    }

    const created = await db.insert(jobs).values({
      title,
      department: department || 'General',
      status: status || 'draft',
      type: type || 'Full-time',
      location: location || 'Remote',
      description: description || '',
      accountId,
      payPackageMin: body.payPackageMin ?? null,
      payPackageMax: body.payPackageMax ?? null,
      payCurrency: body.payCurrency ?? 'INR',
      applicants: 0,
      createdBy: userId,
      // Job creator is the default owner; change later via Edit job → Assigned staff.
      assignedTo: body.assignedTo ?? userId,
    }).returning();

    const job = created[0];
    if (job.accountId != null) {
      await copyAccountStageTemplatesToJob(job.accountId, job.id);
    }

    return c.json(job, 201);
  } catch {
    return c.json({ error: 'Failed to create job' }, 500);
  }
});

// PATCH /jobs/:id/status — explicit lifecycle transition
jobsRouter.patch('/:id/status', requireAuth, zValidator('json', statusSchema), async (c) => {
  try {
    const orgId = c.get('organizationId') as number | null;
    const userId = c.get('userId') as number;
    const role = c.get('userRole') as UserRole | null;
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const { status: nextStatus } = c.req.valid('json');

    const row = await selectJobById(id);
    if (row.length === 0) return c.json({ error: 'Job not found' }, 404);

    if (!await canAccessJob(row[0], userId, orgId, role)) {
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
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const id = parseInt(c.req.param('id'));
    const body = c.req.valid('json');

    const existing = await selectJobById(id);
    if (existing.length === 0) {
      return c.json({ error: 'Job not found or unauthorized' }, 403);
    }
    if (!await canAccessJob(existing[0], userId, orgId, role)) {
      return c.json({ error: 'Job not found or unauthorized' }, 403);
    }

    if (body.accountId != null) {
      const account = await getAccountIfAccessible(body.accountId, userId, orgId, role);
      if (!account) return c.json({ error: 'Client account not found or unauthorized' }, 403);
    }

    const patch: Record<string, unknown> = {};
    for (const k of ['title','department','status','type','location','description','accountId','payPackageMin','payPackageMax','payCurrency','assignedTo'] as const) {
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
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const id = parseInt(c.req.param('id'));

    const existing = await selectJobById(id);
    if (existing.length === 0) {
      return c.json({ error: 'Job not found or unauthorized' }, 403);
    }
    if (!await canAccessJob(existing[0], userId, orgId, role)) {
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
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const jobId = parseInt(c.req.param('jobId'));
    if (isNaN(jobId)) return c.json({ error: 'Invalid job id' }, 400);

    const job = await canAccessJobForStages({ jobId, userId, orgId, role });
    if (!job) return c.json({ error: 'Job not found or unauthorized' }, 403);

    const stages = await selectJobStages(jobId);
    return c.json({ data: stages });
  } catch {
    return c.json({ error: 'Failed to fetch job stages' }, 500);
  }
});

// POST /jobs/:jobId/stages/sync-from-template — import client default into this job only
jobsRouter.post('/:jobId/stages/sync-from-template', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const jobId = parseInt(c.req.param('jobId'));
    if (isNaN(jobId)) return c.json({ error: 'Invalid job id' }, 400);
    if (!canWriteStageTemplates(role)) {
      return c.json({ error: 'Only admins can modify job stages' }, 403);
    }

    const job = await canAccessJobForStages({ jobId, userId, orgId, role });
    if (!job) return c.json({ error: 'Job not found or unauthorized' }, 403);
    if (job.accountId == null) {
      return c.json({ error: 'Job is not linked to a client account' }, 400);
    }

    const stagesCopied = await copyAccountStageTemplatesToJob(job.accountId, jobId);
    return c.json({ stagesCopied });
  } catch {
    return c.json({ error: 'Failed to sync stages from template' }, 500);
  }
});

// POST /jobs/:jobId/stages
jobsRouter.post('/:jobId/stages', requireAuth, zValidator('json', stageSchema), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const jobId = parseInt(c.req.param('jobId'));
    if (isNaN(jobId)) return c.json({ error: 'Invalid job id' }, 400);
    if (!canWriteStageTemplates(role)) {
      return c.json({ error: 'Only admins can modify job stages' }, 403);
    }

    const job = await canAccessJobForStages({ jobId, userId, orgId, role });
    if (!job) return c.json({ error: 'Job not found or unauthorized' }, 403);

    const b = c.req.valid('json');
    const [hiredStage] = await db
      .select({ orderIndex: jobStages.orderIndex })
      .from(jobStages)
      .where(and(eq(jobStages.jobId, jobId), eq(jobStages.stageType, 'hired')))
      .limit(1);
    // The normalizer is authoritative, but inserting before Hired also prevents a UI flash.
    const orderIndex = hiredStage?.orderIndex ?? 1;
    // Custom stages are always In-Transit. Start/Hired/Rejected are system-only.
    const [created] = await db.insert(jobStages).values({
      jobId,
      name: b.name,
      orderIndex,
      stageType: 'in_transit',
      color: b.color ?? defaultStageColor(orderIndex),
    }).returning();

    await normalizeJobStageOrder(jobId);
    const [normalized] = await db.select().from(jobStages)
      .where(and(eq(jobStages.id, created.id), eq(jobStages.jobId, jobId)))
      .limit(1);
    return c.json(normalized ?? created, 201);
  } catch {
    return c.json({ error: 'Failed to create job stage' }, 500);
  }
});

// PUT /jobs/:jobId/stages/reorder — batch reorder after drag-and-drop
jobsRouter.put('/:jobId/stages/reorder', requireAuth, zValidator('json', reorderStagesSchema), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const jobId = parseInt(c.req.param('jobId'));
    if (isNaN(jobId)) return c.json({ error: 'Invalid job id' }, 400);
    if (!canWriteStageTemplates(role)) {
      return c.json({ error: 'Only admins can modify job stages' }, 403);
    }

    const job = await canAccessJobForStages({ jobId, userId, orgId, role });
    if (!job) return c.json({ error: 'Job not found or unauthorized' }, 403);

    const { stageIds } = c.req.valid('json');
    const existing = await db
      .select({ id: jobStages.id, stageType: jobStages.stageType })
      .from(jobStages)
      .where(eq(jobStages.jobId, jobId));

    if (existing.length === 0) {
      return c.json({ error: 'No stages to reorder' }, 400);
    }

    if (stageIds.length !== existing.length) {
      return c.json({ error: 'stageIds must include every stage for this job' }, 400);
    }

    const existingIdSet = new Set(existing.map((row) => row.id));
    if (!stageIds.every((id) => existingIdSet.has(id))) {
      return c.json({ error: 'Invalid stageIds for this job' }, 400);
    }

    const inTransitIds = stageIds.filter((id) =>
      existing.some((stage) => stage.id === id && stage.stageType === 'in_transit'),
    );
    await normalizeJobStageOrder(jobId, inTransitIds);

    const stages = await db
      .select()
      .from(jobStages)
      .where(eq(jobStages.jobId, jobId))
      .orderBy(jobStages.orderIndex);

    return c.json({ data: stages });
  } catch {
    return c.json({ error: 'Failed to reorder job stages' }, 500);
  }
});

// PUT /jobs/:jobId/stages/:stageId
jobsRouter.put('/:jobId/stages/:stageId', requireAuth, zValidator('json', stageSchema.partial()), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const jobId = parseInt(c.req.param('jobId'));
    const stageId = parseInt(c.req.param('stageId'));
    if (isNaN(jobId) || isNaN(stageId)) return c.json({ error: 'Invalid id' }, 400);
    if (!canWriteStageTemplates(role)) {
      return c.json({ error: 'Only admins can modify job stages' }, 403);
    }

    const job = await canAccessJobForStages({ jobId, userId, orgId, role });
    if (!job) return c.json({ error: 'Job not found or unauthorized' }, 403);

    const [existing] = await db.select().from(jobStages)
      .where(and(eq(jobStages.id, stageId), eq(jobStages.jobId, jobId))).limit(1);
    if (!existing) return c.json({ error: 'Stage not found' }, 404);

    const b = c.req.valid('json');
    const patch: Record<string, unknown> = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.color !== undefined) patch.color = b.color;
    // Stage type is immutable. System types are unique and custom stages stay In-Transit.

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
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const jobId = parseInt(c.req.param('jobId'));
    const stageId = parseInt(c.req.param('stageId'));
    if (isNaN(jobId) || isNaN(stageId)) return c.json({ error: 'Invalid id' }, 400);
    if (!canWriteStageTemplates(role)) {
      return c.json({ error: 'Only admins can modify job stages' }, 403);
    }

    const job = await canAccessJobForStages({ jobId, userId, orgId, role });
    if (!job) return c.json({ error: 'Job not found or unauthorized' }, 403);

    const [stage] = await db.select().from(jobStages)
      .where(and(eq(jobStages.id, stageId), eq(jobStages.jobId, jobId))).limit(1);
    if (!stage) return c.json({ error: 'Stage not found' }, 404);

    const LOCKED_TYPES = new Set(['initial', 'hired', 'rejected']);
    if (LOCKED_TYPES.has(stage.stageType)) {
      return c.json({ error: 'Default stages (Start, Hired, Rejected) cannot be deleted' }, 403);
    }

    const appsOnStage = await db
      .select({ id: applications.id })
      .from(applications)
      .where(and(eq(applications.jobId, jobId), eq(applications.jobStageId, stageId)));

    await db.delete(jobStages).where(and(eq(jobStages.id, stageId), eq(jobStages.jobId, jobId)));
    return c.json({ ok: true, applicationsUnassigned: appsOnStage.length });
  } catch {
    return c.json({ error: 'Failed to delete job stage' }, 500);
  }
});

// GET /jobs/:jobId/stage-stats — headcounts + transition edge counts for pipeline mindmap
jobsRouter.get('/:jobId/stage-stats', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const jobId = parseInt(c.req.param('jobId'));
    if (isNaN(jobId)) return c.json({ error: 'Invalid job id' }, 400);

    const job = await canAccessJobForStages({ jobId, userId, orgId, role });
    if (!job) return c.json({ error: 'Job not found or unauthorized' }, 403);

    await backfillNullApplicationStages(jobId);
    await ensureApplicationHistoryStageColumns();

    const stages = await selectJobStages(jobId);
    const stageIdSet = new Set(stages.map((s) => s.id));

    let apps: Array<{ jobStageId: number | null }> = [];
    try {
      apps = await db
        .select({ jobStageId: applications.jobStageId })
        .from(applications)
        .where(eq(applications.jobId, jobId));
    } catch {
      apps = [];
    }

    const countByStage = new Map<number, number>();
    let unassigned = 0;
    for (const app of apps) {
      if (app.jobStageId == null) {
        unassigned += 1;
      } else {
        countByStage.set(app.jobStageId, (countByStage.get(app.jobStageId) ?? 0) + 1);
      }
    }

    const data = stages.map((stage, index) => ({
      stageId: stage.id,
      stageKey: `S${index + 1}`,
      name: stage.name,
      color: stage.color ?? defaultStageColor(index),
      orderIndex: stage.orderIndex,
      count: countByStage.get(stage.id) ?? 0,
    }));

    // Transition edges: how many candidates moved from stage A → stage B
    const transitions: Array<{ fromStageId: number; toStageId: number; count: number }> = [];
    try {
      const appIds = (
        await db.select({ id: applications.id }).from(applications).where(eq(applications.jobId, jobId))
      ).map((r) => r.id);

      if (appIds.length > 0) {
        const historyRows = await db
          .select({
            fromStageId: applicationStageHistory.fromStageId,
            toStageId: applicationStageHistory.toStageId,
          })
          .from(applicationStageHistory)
          .where(inArray(applicationStageHistory.applicationId, appIds));

        const edgeCounts = new Map<string, number>();
        for (const row of historyRows) {
          if (row.fromStageId == null || row.toStageId == null) continue;
          if (!stageIdSet.has(row.fromStageId) || !stageIdSet.has(row.toStageId)) continue;
          if (row.fromStageId === row.toStageId) continue;
          const key = `${row.fromStageId}->${row.toStageId}`;
          edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
        }
        for (const [key, count] of edgeCounts) {
          const [fromRaw, toRaw] = key.split('->');
          transitions.push({
            fromStageId: Number(fromRaw),
            toStageId: Number(toRaw),
            count,
          });
        }
      }
    } catch {
      // Columns may not exist yet on older DBs — mindmap falls back to headcounts.
    }

    return c.json({
      data,
      transitions,
      totalApplications: apps.length,
      unassignedCount: unassigned,
    });
  } catch {
    return c.json({ error: 'Failed to fetch stage stats' }, 500);
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
