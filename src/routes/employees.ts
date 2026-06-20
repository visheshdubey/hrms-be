import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import {
  employees, candidates, users, onboardingWorkflows,
  EMPLOYEE_STATUSES, EMPLOYMENT_TYPES, ONBOARDING_STATUSES,
} from '../db/schema.js';
import { eq, desc, and, sql } from 'drizzle-orm';
import { requireAuth, requireRole, type AppContext } from '../middleware.js';

const employeesRouter = new Hono<AppContext>({ strict: false });

type EmpStatus = typeof EMPLOYEE_STATUSES[number];
type EmpType = typeof EMPLOYMENT_TYPES[number];

const STATUS_LABELS: Record<EmpStatus, string> = {
  active: 'Active', offboarded: 'Offboarded', on_bench: 'On Bench',
};
const TYPE_LABELS: Record<EmpType, string> = {
  full_time: 'Full Time', contractor: 'Contractor', part_time: 'Part Time', intern: 'Intern',
};

const DEFAULT_TASKS = [
  { id: '1', title: 'Offer letter signed', status: 'pending', dueDate: '' },
  { id: '2', title: 'Background verification', status: 'pending', dueDate: '' },
  { id: '3', title: 'IT equipment request', status: 'pending', dueDate: '' },
  { id: '4', title: 'HR orientation', status: 'pending', dueDate: '' },
];
const DEFAULT_DOCS = [
  { id: '1', name: 'Government ID', status: 'pending' },
  { id: '2', name: 'Proof of address', status: 'pending' },
  { id: '3', name: 'Bank details', status: 'pending' },
  { id: '4', name: 'Signed offer letter', status: 'pending' },
];

async function nextEmployeeCode(orgId: number | null): Promise<string> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(employees)
    .where(orgId != null ? eq(employees.organizationId, orgId) : sql`1=1`);
  const n = Number(row?.count ?? 0) + 1;
  return `EMP-${String(n).padStart(4, '0')}`;
}

async function nextWorkflowCode(orgId: number | null): Promise<string> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(onboardingWorkflows)
    .where(orgId != null ? eq(onboardingWorkflows.organizationId, orgId) : sql`1=1`);
  const n = Number(row?.count ?? 0) + 1;
  return `ONB-${String(n).padStart(4, '0')}`;
}

async function enrichEmployee(row: typeof employees.$inferSelect) {
  let reportingToName = '';
  if (row.reportingToId) {
    const [mgr] = await db.select({
      firstName: employees.firstName, lastName: employees.lastName,
    }).from(employees).where(eq(employees.id, row.reportingToId));
    if (mgr) reportingToName = `${mgr.firstName} ${mgr.lastName}`.trim();
  }
  let creatorName = '';
  if (row.createdBy) {
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, row.createdBy));
    creatorName = u?.name ?? '';
  }
  return {
    ...row,
    fullName: `${row.firstName} ${row.lastName}`.trim(),
    reportingToName,
    creatorName,
    statusLabel: STATUS_LABELS[row.status as EmpStatus] ?? row.status,
    employmentTypeLabel: TYPE_LABELS[row.employmentType as EmpType] ?? row.employmentType,
  };
}

const employeeBody = z.object({
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  jobTitle: z.string().optional(),
  department: z.string().optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  status: z.enum(EMPLOYEE_STATUSES).optional(),
  reportingToId: z.number().int().positive().optional().nullable(),
  hireDate: z.string().optional(),
  userId: z.number().int().positive().optional().nullable(),
  candidateId: z.number().int().positive().optional().nullable(),
  applicationId: z.number().int().positive().optional().nullable(),
});

const fromCandidateBody = z.object({
  candidateId: z.number().int().positive(),
  applicationId: z.number().int().positive().optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  department: z.string().optional(),
  jobTitle: z.string().optional(),
  reportingToId: z.number().int().positive().optional().nullable(),
  hireDate: z.string().optional(),
  startOnboarding: z.boolean().optional(),
});

function orgWhere(orgId: number | null) {
  return orgId != null ? eq(employees.organizationId, orgId) : sql`1=1`;
}

/* GET /employees */
employeesRouter.get('/', requireAuth, requireRole('org_admin', 'org_staff'), async (c) => {
  try {
    const orgId = c.get('organizationId') as number | null;
    const view = c.req.query('view') ?? 'all';
    const search = c.req.query('search')?.trim().toLowerCase() ?? '';
    const page = Math.max(1, parseInt(c.req.query('page') ?? '1') || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query('pageSize') ?? '15') || 15));

    let rows = await db.select().from(employees)
      .where(orgWhere(orgId))
      .orderBy(desc(employees.updatedAt));

    if (view === 'active') rows = rows.filter((r) => r.status === 'active');
    if (view === 'offboarded') rows = rows.filter((r) => r.status === 'offboarded');
    if (view === 'on_bench') rows = rows.filter((r) => r.status === 'on_bench');
    if (view === 'recent') {
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
      rows = rows.filter((r) => r.createdAt >= cutoff);
    }

    const enriched = await Promise.all(rows.map(enrichEmployee));
    const filtered = search
      ? enriched.filter((e) => {
          const blob = `${e.employeeCode} ${e.fullName} ${e.email} ${e.jobTitle} ${e.department}`.toLowerCase();
          return blob.includes(search);
        })
      : enriched;

    const total = filtered.length;
    const start = (page - 1) * pageSize;
    return c.json({ data: filtered.slice(start, start + pageSize), total, page, pageSize });
  } catch {
    return c.json({ error: 'Failed to fetch employees' }, 500);
  }
});

/* POST /employees/from-candidate — must be before /:id */
employeesRouter.post('/from-candidate', requireAuth, requireRole('org_admin', 'org_staff'), zValidator('json', fromCandidateBody), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const b = c.req.valid('json');
    const now = new Date().toISOString();

    const [cand] = await db.select().from(candidates).where(eq(candidates.id, b.candidateId)).limit(1);
    if (!cand) return c.json({ error: 'Candidate not found' }, 404);

    const existing = await db.select().from(employees)
      .where(and(eq(employees.candidateId, b.candidateId), orgWhere(orgId)))
      .limit(1);
    if (existing.length) return c.json({ error: 'Employee record already exists for this candidate' }, 409);

    const nameParts = (cand.name || 'Unknown').split(' ');
    const firstName = nameParts[0] ?? 'Unknown';
    const lastName = nameParts.slice(1).join(' ');

    const [created] = await db.insert(employees).values({
      employeeCode: await nextEmployeeCode(orgId),
      candidateId: b.candidateId,
      applicationId: b.applicationId ?? null,
      firstName,
      lastName,
      email: cand.email ?? '',
      phone: cand.phone ?? '',
      jobTitle: b.jobTitle ?? '',
      department: b.department ?? '',
      employmentType: b.employmentType ?? 'full_time',
      status: 'active',
      reportingToId: b.reportingToId ?? null,
      hireDate: b.hireDate ?? now.slice(0, 10),
      organizationId: orgId,
      createdBy: userId,
      updatedAt: now,
    }).returning();

    await db.update(candidates).set({ status: 'Hired' }).where(eq(candidates.id, b.candidateId));

    let onboarding = null;
    if (b.startOnboarding !== false) {
      const [wf] = await db.insert(onboardingWorkflows).values({
        workflowCode: await nextWorkflowCode(orgId),
        employeeId: created.id,
        candidateId: b.candidateId,
        status: 'in_progress',
        tasksJson: JSON.stringify(DEFAULT_TASKS),
        documentsJson: JSON.stringify(DEFAULT_DOCS),
        organizationId: orgId,
        createdBy: userId,
        updatedAt: now,
      }).returning();
      onboarding = wf;
    }

    return c.json({ employee: await enrichEmployee(created), onboarding }, 201);
  } catch {
    return c.json({ error: 'Failed to convert candidate to employee' }, 500);
  }
});

/* GET /employees/:id */
employeesRouter.get('/:id', requireAuth, requireRole('org_admin', 'org_staff'), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    const [row] = await db.select().from(employees).where(eq(employees.id, id)).limit(1);
    if (!row) return c.json({ error: 'Employee not found' }, 404);
    return c.json(await enrichEmployee(row));
  } catch {
    return c.json({ error: 'Failed to fetch employee' }, 500);
  }
});

/* POST /employees */
employeesRouter.post('/', requireAuth, requireRole('org_admin', 'org_staff'), zValidator('json', employeeBody), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const b = c.req.valid('json');
    const now = new Date().toISOString();

    const [created] = await db.insert(employees).values({
      employeeCode: await nextEmployeeCode(orgId),
      firstName: b.firstName,
      lastName: b.lastName ?? '',
      email: b.email ?? '',
      phone: b.phone ?? '',
      jobTitle: b.jobTitle ?? '',
      department: b.department ?? '',
      employmentType: b.employmentType ?? 'full_time',
      status: b.status ?? 'active',
      reportingToId: b.reportingToId ?? null,
      hireDate: b.hireDate ?? '',
      userId: b.userId ?? null,
      candidateId: b.candidateId ?? null,
      applicationId: b.applicationId ?? null,
      organizationId: orgId,
      createdBy: userId,
      updatedAt: now,
    }).returning();

    return c.json(await enrichEmployee(created), 201);
  } catch {
    return c.json({ error: 'Failed to create employee' }, 500);
  }
});

/* PUT /employees/:id */
employeesRouter.put('/:id', requireAuth, requireRole('org_admin', 'org_staff'), zValidator('json', employeeBody.partial()), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    const b = c.req.valid('json');
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const k of ['firstName','lastName','email','phone','jobTitle','department','employmentType','status','reportingToId','hireDate','userId','candidateId','applicationId'] as const) {
      if (b[k] !== undefined) patch[k] = b[k];
    }

    const [updated] = await db.update(employees).set(patch as any).where(eq(employees.id, id)).returning();
    if (!updated) return c.json({ error: 'Employee not found' }, 404);
    return c.json(await enrichEmployee(updated));
  } catch {
    return c.json({ error: 'Failed to update employee' }, 500);
  }
});

/* DELETE /employees/:id */
employeesRouter.delete('/:id', requireAuth, requireRole('org_admin'), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const linked = await db.select({ id: onboardingWorkflows.id })
      .from(onboardingWorkflows).where(eq(onboardingWorkflows.employeeId, id)).limit(1);
    if (linked.length) return c.json({ error: 'Cannot delete employee with active onboarding workflows' }, 409);

    await db.delete(employees).where(eq(employees.id, id));
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'Failed to delete employee' }, 500);
  }
});

export default employeesRouter;
