import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import {
  interviews, submissions, candidates, jobs, users, applications,
  INTERVIEW_STATUSES, applicationStageHistory,
} from '../db/schema.js';
import { eq, desc, inArray } from 'drizzle-orm';
import { requireAuth, requireRole, type AppContext } from '../middleware.js';

const interviewsRouter = new Hono<AppContext>({ strict: false });

type IntStatus = typeof INTERVIEW_STATUSES[number];

const STATUS_LABELS: Record<IntStatus, string> = {
  scheduled:  'Scheduled',
  completed:  'Completed',
  cancelled:  'Cancelled',
  no_show:    'No Show',
};

const STAGE_LABELS: Record<string, string> = {
  round_1: 'Round 1', round_2: 'Round 2', technical: 'Technical Round',
  hr: 'HR Round', final: 'Final Round',
};

const TRANSITIONS: Record<IntStatus, IntStatus[]> = {
  scheduled: ['completed', 'cancelled', 'no_show'],
  completed: [],
  cancelled: [],
  no_show:   [],
};

async function orgMemberIds(orgId: number | null, userId: number): Promise<number[]> {
  if (orgId == null) return [userId];
  const members = await db.select({ id: users.id }).from(users).where(eq(users.organizationId, orgId));
  return members.map((m) => m.id);
}

function parseIds(json: string): number[] {
  try { const p = JSON.parse(json); return Array.isArray(p) ? p.map(Number).filter(Boolean) : []; }
  catch { return []; }
}

async function enrichInterview(row: Record<string, unknown>) {
  const [cand] = await db.select({
    id: candidates.id, name: candidates.name, email: candidates.email, location: candidates.location,
  }).from(candidates).where(eq(candidates.id, row.candidateId as number));

  const [job] = await db.select({
    id: jobs.id, title: jobs.title, department: jobs.department,
  }).from(jobs).where(eq(jobs.id, row.jobId as number));

  let schedulerName = '';
  if (row.createdBy) {
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, row.createdBy as number));
    schedulerName = u?.name ?? '';
  }

  const ids = parseIds(String(row.interviewerIds ?? '[]'));
  let interviewerNames: string[] = [];
  if (ids.length) {
    const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
    interviewerNames = rows.map((r) => r.name);
  }

  const status = row.status as IntStatus;
  const start = new Date(row.startTime as string);
  const now = Date.now();
  const dueInDays = Math.ceil((start.getTime() - now) / 86400000);

  return {
    ...row,
    candidate: cand ?? null,
    job: job ?? null,
    schedulerName,
    interviewerNames,
    statusLabel: STATUS_LABELS[status] ?? status,
    stageLabel: STAGE_LABELS[String(row.interviewStage)] ?? row.interviewStage,
    allowedTransitions: TRANSITIONS[status] ?? [],
    dueInDays: dueInDays > 0 ? dueInDays : 0,
  };
}

const createSchema = z.object({
  applicationId: z.number().int().positive().optional(),
  submissionId: z.number().int().positive().optional(),
  jobId: z.number().int().positive(),
  candidateId: z.number().int().positive(),
  title: z.string().min(1).optional(),
  startTime: z.string().min(1),
  endTime: z.string().min(1),
  timezone: z.string().default('Asia/Kolkata'),
  interviewStage: z.enum(['round_1', 'round_2', 'technical', 'hr', 'final']).default('round_1'),
  submissionStage: z.enum(['internal', 'client']).default('internal'),
  accountName: z.string().optional(),
  endClient: z.string().optional(),
  interviewerIds: z.array(z.number().int()).default([]),
  durationMinutes: z.number().int().positive().optional(),
});

const statusSchema = z.object({ status: z.enum(INTERVIEW_STATUSES) });

/* GET /interviews */
interviewsRouter.get('/', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const view = c.req.query('view') ?? 'all';
    const period = c.req.query('period') ?? 'all';
    const search = c.req.query('search')?.trim().toLowerCase() ?? '';
    const page = Math.max(1, parseInt(c.req.query('page') ?? '1') || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query('pageSize') ?? '20') || 20));

    const memberIds = await orgMemberIds(orgId, userId);
    if (memberIds.length === 0) return c.json({ data: [], total: 0, page, pageSize });

    let rows = await db.select().from(interviews)
      .where(inArray(interviews.createdBy, memberIds))
      .orderBy(desc(interviews.startTime));

    const now = new Date().toISOString();
    if (period === 'upcoming') rows = rows.filter((r) => r.startTime >= now && r.status === 'scheduled');
    if (period === 'past') rows = rows.filter((r) => r.endTime < now || r.status === 'completed');
    if (view === 'mine') rows = rows.filter((r) => r.createdBy === userId);
    if (view === 'active') rows = rows.filter((r) => r.status === 'scheduled');

    const enriched = await Promise.all(rows.map((r) => enrichInterview(r as Record<string, unknown>)));

    const filtered = search
      ? enriched.filter((iv) => {
          const r = iv as typeof iv & { title?: string };
          const blob = `${r.title} ${r.candidate?.name} ${r.job?.title} ${r.schedulerName} ${r.interviewerNames.join(' ')}`.toLowerCase();
          return blob.includes(search);
        })
      : enriched;

    const total = filtered.length;
    const start = (page - 1) * pageSize;
    const data = filtered.slice(start, start + pageSize);

    return c.json({ data, total, page, pageSize });
  } catch {
    return c.json({ error: 'Failed to fetch interviews' }, 500);
  }
});

/* GET /interviews/:id */
interviewsRouter.get('/:id', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    const row = await db.select().from(interviews).where(eq(interviews.id, id)).limit(1);
    if (!row.length) return c.json({ error: 'Interview not found' }, 404);
    return c.json(await enrichInterview(row[0] as Record<string, unknown>));
  } catch {
    return c.json({ error: 'Failed to fetch interview' }, 500);
  }
});

/* POST /interviews — schedule */
interviewsRouter.post('/', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), zValidator('json', createSchema), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const b = c.req.valid('json');
    const now = new Date().toISOString();

    const [cand] = await db.select({ name: candidates.name }).from(candidates).where(eq(candidates.id, b.candidateId));
    const [job] = await db.select({ title: jobs.title }).from(jobs).where(eq(jobs.id, b.jobId));

    const title = b.title ?? `Scheduled Interview - ${cand?.name ?? 'Candidate'} for ${job?.title ?? 'Job'}`;

    const [created] = await db.insert(interviews).values({
      applicationId: b.applicationId ?? null,
      submissionId: b.submissionId ?? null,
      jobId: b.jobId,
      candidateId: b.candidateId,
      title,
      startTime: b.startTime,
      endTime: b.endTime,
      timezone: b.timezone,
      interviewStage: b.interviewStage,
      submissionStage: b.submissionStage,
      accountName: b.accountName ?? '',
      endClient: b.endClient ?? '',
      interviewerIds: JSON.stringify(b.interviewerIds),
      durationMinutes: b.durationMinutes ?? 60,
      sentOn: now.split('T')[0],
      organizationId: orgId,
      createdBy: userId,
      updatedAt: now,
    }).returning();

    // Advance linked application to interview_scheduled when applicable
    if (b.applicationId) {
      const app = await db.select().from(applications).where(eq(applications.id, b.applicationId)).limit(1);
      if (app.length && ['shortlisted', 'hold'].includes(app[0].status)) {
        await db.update(applications).set({ status: 'interview_scheduled', updatedAt: now }).where(eq(applications.id, b.applicationId));
        await db.insert(applicationStageHistory).values({
          applicationId: b.applicationId, fromStatus: app[0].status, toStatus: 'interview_scheduled',
          note: 'Interview scheduled', changedBy: userId,
        });
      }
    }

    // Client-stage interview → bump submission status
    if (b.submissionId && b.submissionStage === 'client') {
      await db.update(submissions).set({
        status: 'client_interview_scheduled', updatedAt: now,
      }).where(eq(submissions.id, b.submissionId));
    }

    return c.json(await enrichInterview(created as Record<string, unknown>), 201);
  } catch {
    return c.json({ error: 'Failed to schedule interview' }, 500);
  }
});

/* PATCH /interviews/:id/status */
interviewsRouter.patch('/:id/status', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), zValidator('json', statusSchema), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    const { status: next } = c.req.valid('json');

    const row = await db.select().from(interviews).where(eq(interviews.id, id)).limit(1);
    if (!row.length) return c.json({ error: 'Interview not found' }, 404);

    const current = row[0].status as IntStatus;
    const allowed = TRANSITIONS[current] ?? [];
    if (!allowed.includes(next)) {
      return c.json({ error: `Invalid transition: ${current} → ${next}`, allowedTransitions: allowed }, 400);
    }

    const [updated] = await db.update(interviews).set({
      status: next, updatedAt: new Date().toISOString(),
    }).where(eq(interviews.id, id)).returning();

    return c.json(await enrichInterview(updated as Record<string, unknown>));
  } catch {
    return c.json({ error: 'Failed to update interview status' }, 500);
  }
});

export default interviewsRouter;
