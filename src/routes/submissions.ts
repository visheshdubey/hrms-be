import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import {
  submissions, interviews, candidates, jobs, users,
  SUBMISSION_STATUSES,
} from '../db/schema.js';
import { eq, desc, inArray } from 'drizzle-orm';
import { requireAuth, requireRole, type AppContext } from '../middleware.js';

const submissionsRouter = new Hono<AppContext>({ strict: false });

type SubStatus = typeof SUBMISSION_STATUSES[number];

const STATUS_LABELS: Record<SubStatus, string> = {
  internal_submitted:          'Internal - Submitted',
  client_review:               'Client - In Review',
  client_interview_scheduled:  'Client - Interview Scheduled',
  client_rejected:             'Client - Rejected',
  client_accepted:             'Client - Accepted',
  withdrawn:                   'Withdrawn',
};

const TRANSITIONS: Record<SubStatus, SubStatus[]> = {
  internal_submitted:         ['client_review', 'withdrawn'],
  client_review:              ['client_interview_scheduled', 'client_rejected', 'withdrawn'],
  client_interview_scheduled: ['client_accepted', 'client_rejected', 'withdrawn'],
  client_rejected:            [],
  client_accepted:            [],
  withdrawn:                  [],
};

async function orgMemberIds(orgId: number | null, userId: number): Promise<number[]> {
  if (orgId == null) return [userId];
  const members = await db.select({ id: users.id }).from(users).where(eq(users.organizationId, orgId));
  return members.map((m) => m.id);
}

async function enrichSubmission(row: Record<string, unknown>) {
  const [cand] = await db.select({
    id: candidates.id, name: candidates.name, email: candidates.email,
    location: candidates.location, matchScore: candidates.matchScore,
  }).from(candidates).where(eq(candidates.id, row.candidateId as number));

  const [job] = await db.select({
    id: jobs.id, title: jobs.title, department: jobs.department, type: jobs.type,
  }).from(jobs).where(eq(jobs.id, row.jobId as number));

  let submitterName = '';
  if (row.submittedBy) {
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, row.submittedBy as number));
    submitterName = u?.name ?? '';
  }

  const status = row.status as SubStatus;
  return {
    ...row,
    candidate: cand ?? null,
    job: job ?? null,
    submitterName,
    statusLabel: STATUS_LABELS[status] ?? status,
    allowedTransitions: TRANSITIONS[status] ?? [],
  };
}

const createSchema = z.object({
  applicationId: z.number().int().positive().optional(),
  jobId: z.number().int().positive(),
  candidateId: z.number().int().positive(),
  clientName: z.string().optional(),
  jobHiringType: z.string().optional(),
  candidateCtcType: z.enum(['annual_salary', 'hourly', 'monthly']).default('annual_salary'),
  candidateCtc: z.number().nonnegative().optional(),
});

const statusSchema = z.object({
  status: z.enum(SUBMISSION_STATUSES),
  reasonForRejection: z.string().optional(),
  rejectionComments: z.string().optional(),
});

const updateSchema = z.object({
  clientName: z.string().optional(),
  jobHiringType: z.string().optional(),
  candidateCtcType: z.enum(['annual_salary', 'hourly', 'monthly']).optional(),
  candidateCtc: z.number().nonnegative().optional(),
  reasonForRejection: z.string().optional(),
  rejectionComments: z.string().optional(),
});

/* GET /submissions — recruiter portal */
submissionsRouter.get('/', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const view = c.req.query('view') ?? 'all';
    const search = c.req.query('search')?.trim().toLowerCase() ?? '';
    const page = Math.max(1, parseInt(c.req.query('page') ?? '1') || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query('pageSize') ?? '20') || 20));

    const memberIds = await orgMemberIds(orgId, userId);
    if (memberIds.length === 0) return c.json({ data: [], total: 0, page, pageSize });

    let rows = await db.select().from(submissions)
      .where(inArray(submissions.submittedBy, memberIds))
      .orderBy(desc(submissions.submittedAt));

    if (view === 'mine') rows = rows.filter((r) => r.submittedBy === userId);
    if (view === 'recent') {
      const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
      rows = rows.filter((r) => r.submittedAt >= cutoff);
    }

    const enriched = await Promise.all(rows.map((r) => enrichSubmission(r as Record<string, unknown>)));

    const filtered = search
      ? enriched.filter((s) => {
          const r = s as typeof s & { clientName?: string };
          const blob = `${r.candidate?.name} ${r.job?.title} ${r.clientName} ${r.statusLabel}`.toLowerCase();
          return blob.includes(search);
        })
      : enriched;

    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const data = filtered.slice(start, start + pageSize);

    return c.json({ data, total, page, pageSize });
  } catch {
    return c.json({ error: 'Failed to fetch submissions' }, 500);
  }
});

/* GET /submissions/:id */
submissionsRouter.get('/:id', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    const row = await db.select().from(submissions).where(eq(submissions.id, id)).limit(1);
    if (!row.length) return c.json({ error: 'Submission not found' }, 404);
    return c.json(await enrichSubmission(row[0] as Record<string, unknown>));
  } catch {
    return c.json({ error: 'Failed to fetch submission' }, 500);
  }
});

/* POST /submissions */
submissionsRouter.post('/', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), zValidator('json', createSchema), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const b = c.req.valid('json');
    const now = new Date().toISOString();

    const [created] = await db.insert(submissions).values({
      applicationId: b.applicationId ?? null,
      jobId: b.jobId,
      candidateId: b.candidateId,
      clientName: b.clientName ?? '',
      jobHiringType: b.jobHiringType ?? 'Direct Client',
      candidateCtcType: b.candidateCtcType,
      candidateCtc: b.candidateCtc ?? 0,
      submittedBy: userId,
      organizationId: orgId,
      submittedAt: now,
      updatedAt: now,
    }).returning();

    return c.json(await enrichSubmission(created as Record<string, unknown>), 201);
  } catch {
    return c.json({ error: 'Failed to create submission' }, 500);
  }
});

/* PATCH /submissions/:id/status */
submissionsRouter.patch('/:id/status', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), zValidator('json', statusSchema), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    const { status: next, reasonForRejection, rejectionComments } = c.req.valid('json');

    const row = await db.select().from(submissions).where(eq(submissions.id, id)).limit(1);
    if (!row.length) return c.json({ error: 'Submission not found' }, 404);

    const current = row[0].status as SubStatus;
    const allowed = TRANSITIONS[current] ?? [];
    if (!allowed.includes(next)) {
      return c.json({ error: `Invalid transition: ${current} → ${next}`, allowedTransitions: allowed }, 400);
    }

    const patch: Record<string, unknown> = { status: next, updatedAt: new Date().toISOString() };
    if (next === 'client_rejected') {
      if (reasonForRejection) patch.reasonForRejection = reasonForRejection;
      if (rejectionComments) patch.rejectionComments = rejectionComments;
    }

    const [updated] = await db.update(submissions).set(patch as any).where(eq(submissions.id, id)).returning();
    return c.json(await enrichSubmission(updated as Record<string, unknown>));
  } catch {
    return c.json({ error: 'Failed to update submission status' }, 500);
  }
});

/* PATCH /submissions/:id */
submissionsRouter.patch('/:id', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), zValidator('json', updateSchema), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    const b = c.req.valid('json');
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (b.clientName != null) patch.clientName = b.clientName;
    if (b.jobHiringType != null) patch.jobHiringType = b.jobHiringType;
    if (b.candidateCtcType != null) patch.candidateCtcType = b.candidateCtcType;
    if (b.candidateCtc != null) patch.candidateCtc = b.candidateCtc;
    if (b.reasonForRejection != null) patch.reasonForRejection = b.reasonForRejection;
    if (b.rejectionComments != null) patch.rejectionComments = b.rejectionComments;

    const [updated] = await db.update(submissions).set(patch as any).where(eq(submissions.id, id)).returning();
    if (!updated) return c.json({ error: 'Submission not found' }, 404);
    return c.json(await enrichSubmission(updated as Record<string, unknown>));
  } catch {
    return c.json({ error: 'Failed to update submission' }, 500);
  }
});

export default submissionsRouter;
