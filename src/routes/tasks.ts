import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import {
  tasks, users, candidates, jobs,
  TASK_PRIORITIES, TASK_STATUSES, TASK_CATEGORIES,
} from '../db/schema.js';
import { eq, desc, inArray, sql } from 'drizzle-orm';
import { requireAuth, requireRole, type AppContext } from '../middleware.js';
import { getOrgMemberIds } from '../lib/orgScope.js';
import { parsePagination, paginateInMemory } from '../lib/pagination.js';
import { MS_PER_DAY, RECENT_DAYS } from '../config.js';

const tasksRouter = new Hono<AppContext>({ strict: false });

type TaskPriority = typeof TASK_PRIORITIES[number];
type TaskStatus = typeof TASK_STATUSES[number];
type TaskCategory = typeof TASK_CATEGORIES[number];

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  high: 'High', medium: 'Medium', low: 'Low',
};
const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: 'Pending', in_progress: 'In Progress', completed: 'Completed',
};
const CATEGORY_LABELS: Record<TaskCategory, string> = {
  general: 'General',
  interview: 'Interview',
  follow_up: 'Follow-up',
  submission: 'Submission',
  client_call: 'Client Call',
  screening: 'Screening',
};

async function nextTaskCode(orgId: number | null): Promise<string> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(orgId != null ? eq(tasks.organizationId, orgId) : sql`1=1`);
  const n = Number(row?.count ?? 0) + 1;
  return `TSK-${String(n).padStart(4, '0')}`;
}

async function enrichTask(row: typeof tasks.$inferSelect) {
  let creatorName = '';
  if (row.createdBy) {
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, row.createdBy));
    creatorName = u?.name ?? '';
  }
  let assigneeName = '';
  if (row.assignedTo) {
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, row.assignedTo));
    assigneeName = u?.name ?? '';
  }
  let candidateName = '';
  if (row.candidateId) {
    const [c] = await db.select({ name: candidates.name }).from(candidates).where(eq(candidates.id, row.candidateId));
    candidateName = c?.name ?? '';
  }
  let jobTitle = '';
  if (row.jobId) {
    const [j] = await db.select({ title: jobs.title }).from(jobs).where(eq(jobs.id, row.jobId));
    jobTitle = j?.title ?? '';
  }

  const today = new Date().toISOString().slice(0, 10);
  const due = row.dueDate ?? '';
  const isExpired = row.status !== 'completed' && due !== '' && due < today;

  return {
    ...row,
    creatorName,
    assigneeName,
    candidateName,
    jobTitle,
    priorityLabel: PRIORITY_LABELS[row.priority as TaskPriority] ?? row.priority,
    statusLabel: STATUS_LABELS[row.status as TaskStatus] ?? row.status,
    categoryLabel: CATEGORY_LABELS[row.category as TaskCategory] ?? row.category,
    isExpired,
  };
}

const taskBody = z.object({
  title: z.string().min(1, 'Task title is required'),
  category: z.enum(TASK_CATEGORIES).optional(),
  description: z.string().optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  dueDate: z.string().optional(),
  reminderAt: z.string().optional(),
  assignedTo: z.number().int().positive().optional().nullable(),
  candidateId: z.number().int().positive().optional().nullable(),
  jobId: z.number().int().positive().optional().nullable(),
});

/* GET /tasks */
tasksRouter.get('/', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const view = c.req.query('view') ?? 'all';
    const statusFilter = c.req.query('status');
    const search = c.req.query('search')?.trim().toLowerCase() ?? '';
    const { page, pageSize } = parsePagination(c.req.query());

    const memberIds = await getOrgMemberIds(orgId, userId);
    if (memberIds.length === 0) return c.json({ data: [], total: 0, page, pageSize });

    let rows = await db.select().from(tasks)
      .where(inArray(tasks.createdBy, memberIds))
      .orderBy(desc(tasks.updatedAt));

    const today = new Date().toISOString().slice(0, 10);

    if (view === 'today') rows = rows.filter((r) => (r.dueDate ?? '') === today);
    if (view === 'upcoming') rows = rows.filter((r) => (r.dueDate ?? '') > today && r.status !== 'completed');
    if (view === 'created_by_me') rows = rows.filter((r) => r.createdBy === userId);
    if (view === 'assigned_to_me') rows = rows.filter((r) => r.assignedTo === userId);
    if (view === 'expired') rows = rows.filter((r) => r.status !== 'completed' && (r.dueDate ?? '') !== '' && (r.dueDate ?? '') < today);
    if (view === 'completed') rows = rows.filter((r) => r.status === 'completed');

    if (statusFilter && statusFilter !== 'all') rows = rows.filter((r) => r.status === statusFilter);

    const enriched = await Promise.all(rows.map(enrichTask));
    const filtered = search
      ? enriched.filter((t) => {
          const blob = `${t.taskCode} ${t.title} ${t.categoryLabel} ${t.assigneeName}`.toLowerCase();
          return blob.includes(search);
        })
      : enriched;

    return c.json(paginateInMemory(filtered, page, pageSize));
  } catch {
    return c.json({ error: 'Failed to fetch tasks' }, 500);
  }
});

/* GET /tasks/:id */
tasksRouter.get('/:id', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1);
    if (!row) return c.json({ error: 'Task not found' }, 404);
    return c.json(await enrichTask(row));
  } catch {
    return c.json({ error: 'Failed to fetch task' }, 500);
  }
});

/* POST /tasks */
tasksRouter.post('/', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), zValidator('json', taskBody), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const b = c.req.valid('json');
    const now = new Date().toISOString();

    const [created] = await db.insert(tasks).values({
      taskCode: await nextTaskCode(orgId),
      title: b.title,
      category: b.category ?? 'general',
      description: b.description ?? '',
      priority: b.priority ?? 'medium',
      status: b.status ?? 'pending',
      dueDate: b.dueDate ?? '',
      reminderAt: b.reminderAt ?? '',
      assignedTo: b.assignedTo ?? userId,
      candidateId: b.candidateId ?? null,
      jobId: b.jobId ?? null,
      organizationId: orgId,
      createdBy: userId,
      updatedAt: now,
    }).returning();

    return c.json(await enrichTask(created), 201);
  } catch {
    return c.json({ error: 'Failed to create task' }, 500);
  }
});

/* PUT /tasks/:id */
tasksRouter.put('/:id', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), zValidator('json', taskBody.partial()), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    const b = c.req.valid('json');
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const k of ['title','category','description','priority','status','dueDate','reminderAt','assignedTo','candidateId','jobId'] as const) {
      if (b[k] !== undefined) patch[k] = b[k];
    }

    const [updated] = await db.update(tasks).set(patch as any).where(eq(tasks.id, id)).returning();
    if (!updated) return c.json({ error: 'Task not found' }, 404);
    return c.json(await enrichTask(updated));
  } catch {
    return c.json({ error: 'Failed to update task' }, 500);
  }
});

/* DELETE /tasks/:id */
tasksRouter.delete('/:id', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    await db.delete(tasks).where(eq(tasks.id, id));
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'Failed to delete task' }, 500);
  }
});

export default tasksRouter;
