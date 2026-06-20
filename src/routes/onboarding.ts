import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import {
  onboardingWorkflows, employees, candidates, users,
  ONBOARDING_STATUSES,
} from '../db/schema.js';
import { eq, desc, sql } from 'drizzle-orm';
import { requireAuth, requireRole, type AppContext } from '../middleware.js';

const onboardingRouter = new Hono<AppContext>({ strict: false });

type OnbStatus = typeof ONBOARDING_STATUSES[number];

const STATUS_LABELS: Record<OnbStatus, string> = {
  draft: 'Draft',
  request: 'Request for Onboarding',
  in_progress: 'In Progress',
  awaiting_confirmation: 'Awaiting Confirmation',
  completed: 'Completed',
  discontinued: 'Discontinued',
  washed_away: 'Washed Away',
  pending_approvals: 'Pending Approvals',
  profile_update: 'Profile Update Request',
};

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
  dueDate: z.string().optional(),
  assignee: z.string().optional(),
});

const docSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(['pending', 'uploaded', 'approved', 'rejected']),
  url: z.string().optional(),
});

const DEFAULT_TASKS = [
  { id: '1', title: 'Offer letter signed', status: 'pending' as const, dueDate: '' },
  { id: '2', title: 'Background verification', status: 'pending' as const, dueDate: '' },
  { id: '3', title: 'IT equipment request', status: 'pending' as const, dueDate: '' },
  { id: '4', title: 'HR orientation', status: 'pending' as const, dueDate: '' },
];
const DEFAULT_DOCS = [
  { id: '1', name: 'Government ID', status: 'pending' as const },
  { id: '2', name: 'Proof of address', status: 'pending' as const },
  { id: '3', name: 'Bank details', status: 'pending' as const },
  { id: '4', name: 'Signed offer letter', status: 'pending' as const },
];

async function nextWorkflowCode(orgId: number | null): Promise<string> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(onboardingWorkflows)
    .where(orgId != null ? eq(onboardingWorkflows.organizationId, orgId) : sql`1=1`);
  const n = Number(row?.count ?? 0) + 1;
  return `ONB-${String(n).padStart(4, '0')}`;
}

async function enrichWorkflow(row: typeof onboardingWorkflows.$inferSelect) {
  let employeeName = '';
  let employeeEmail = '';
  if (row.employeeId) {
    const [emp] = await db.select({
      firstName: employees.firstName, lastName: employees.lastName, email: employees.email,
    }).from(employees).where(eq(employees.id, row.employeeId));
    if (emp) {
      employeeName = `${emp.firstName} ${emp.lastName}`.trim();
      employeeEmail = emp.email ?? '';
    }
  } else if (row.candidateId) {
    const [cand] = await db.select({ name: candidates.name, email: candidates.email })
      .from(candidates).where(eq(candidates.id, row.candidateId));
    employeeName = cand?.name ?? '';
    employeeEmail = cand?.email ?? '';
  }

  let creatorName = '';
  if (row.createdBy) {
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, row.createdBy));
    creatorName = u?.name ?? '';
  }

  const tasks = JSON.parse(row.tasksJson || '[]') as z.infer<typeof taskSchema>[];
  const documents = JSON.parse(row.documentsJson || '[]') as z.infer<typeof docSchema>[];
  const tasksCompleted = tasks.filter((t) => t.status === 'completed').length;
  const docsApproved = documents.filter((d) => d.status === 'approved' || d.status === 'uploaded').length;

  return {
    ...row,
    tasks,
    documents,
    employeeName,
    employeeEmail,
    creatorName,
    statusLabel: STATUS_LABELS[row.status as OnbStatus] ?? row.status,
    progress: {
      tasksTotal: tasks.length,
      tasksCompleted,
      documentsTotal: documents.length,
      documentsDone: docsApproved,
    },
  };
}

const initiateBody = z.object({
  employeeId: z.number().int().positive().optional(),
  candidateId: z.number().int().positive().optional(),
  status: z.enum(ONBOARDING_STATUSES).optional(),
  notes: z.string().optional(),
}).refine((d) => d.employeeId || d.candidateId, { message: 'employeeId or candidateId is required' });

const updateBody = z.object({
  status: z.enum(ONBOARDING_STATUSES).optional(),
  notes: z.string().optional(),
  tasks: z.array(taskSchema).optional(),
  documents: z.array(docSchema).optional(),
});

function orgWhere(orgId: number | null) {
  return orgId != null ? eq(onboardingWorkflows.organizationId, orgId) : sql`1=1`;
}

const VIEW_STATUS_MAP: Record<string, OnbStatus | null> = {
  all: null,
  draft: 'draft',
  request: 'request',
  in_progress: 'in_progress',
  awaiting_confirmation: 'awaiting_confirmation',
  completed: 'completed',
  discontinued: 'discontinued',
  washed_away: 'washed_away',
  pending_approvals: 'pending_approvals',
  profile_update: 'profile_update',
};

/* GET /onboarding */
onboardingRouter.get('/', requireAuth, requireRole('org_admin', 'org_staff'), async (c) => {
  try {
    const orgId = c.get('organizationId') as number | null;
    const view = c.req.query('view') ?? 'all';
    const search = c.req.query('search')?.trim().toLowerCase() ?? '';
    const page = Math.max(1, parseInt(c.req.query('page') ?? '1') || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query('pageSize') ?? '15') || 15));

    let rows = await db.select().from(onboardingWorkflows)
      .where(orgWhere(orgId))
      .orderBy(desc(onboardingWorkflows.updatedAt));

    const statusFilter = VIEW_STATUS_MAP[view];
    if (statusFilter) rows = rows.filter((r) => r.status === statusFilter);

    const enriched = await Promise.all(rows.map(enrichWorkflow));
    const filtered = search
      ? enriched.filter((w) => {
          const blob = `${w.workflowCode} ${w.creatorName} ${w.employeeName} ${w.employeeEmail}`.toLowerCase();
          return blob.includes(search);
        })
      : enriched;

    const total = filtered.length;
    const start = (page - 1) * pageSize;
    return c.json({ data: filtered.slice(start, start + pageSize), total, page, pageSize });
  } catch {
    return c.json({ error: 'Failed to fetch onboarding workflows' }, 500);
  }
});

/* GET /onboarding/:id */
onboardingRouter.get('/:id', requireAuth, requireRole('org_admin', 'org_staff'), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    const [row] = await db.select().from(onboardingWorkflows).where(eq(onboardingWorkflows.id, id)).limit(1);
    if (!row) return c.json({ error: 'Workflow not found' }, 404);
    return c.json(await enrichWorkflow(row));
  } catch {
    return c.json({ error: 'Failed to fetch workflow' }, 500);
  }
});

/* POST /onboarding */
onboardingRouter.post('/', requireAuth, requireRole('org_admin', 'org_staff'), zValidator('json', initiateBody), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const b = c.req.valid('json');
    const now = new Date().toISOString();

    if (b.employeeId) {
      const [emp] = await db.select().from(employees).where(eq(employees.id, b.employeeId)).limit(1);
      if (!emp) return c.json({ error: 'Employee not found' }, 404);
    }

    const [created] = await db.insert(onboardingWorkflows).values({
      workflowCode: await nextWorkflowCode(orgId),
      employeeId: b.employeeId ?? null,
      candidateId: b.candidateId ?? null,
      status: b.status ?? 'draft',
      tasksJson: JSON.stringify(DEFAULT_TASKS),
      documentsJson: JSON.stringify(DEFAULT_DOCS),
      notes: b.notes ?? '',
      organizationId: orgId,
      createdBy: userId,
      updatedAt: now,
    }).returning();

    return c.json(await enrichWorkflow(created), 201);
  } catch {
    return c.json({ error: 'Failed to initiate onboarding' }, 500);
  }
});

/* PUT /onboarding/:id */
onboardingRouter.put('/:id', requireAuth, requireRole('org_admin', 'org_staff'), zValidator('json', updateBody), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    const b = c.req.valid('json');
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (b.status !== undefined) patch.status = b.status;
    if (b.notes !== undefined) patch.notes = b.notes;
    if (b.tasks !== undefined) patch.tasksJson = JSON.stringify(b.tasks);
    if (b.documents !== undefined) patch.documentsJson = JSON.stringify(b.documents);

    const [updated] = await db.update(onboardingWorkflows).set(patch as any).where(eq(onboardingWorkflows.id, id)).returning();
    if (!updated) return c.json({ error: 'Workflow not found' }, 404);
    return c.json(await enrichWorkflow(updated));
  } catch {
    return c.json({ error: 'Failed to update workflow' }, 500);
  }
});

/* DELETE /onboarding/:id */
onboardingRouter.delete('/:id', requireAuth, requireRole('org_admin'), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    await db.delete(onboardingWorkflows).where(eq(onboardingWorkflows.id, id));
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'Failed to delete workflow' }, 500);
  }
});

export default onboardingRouter;
