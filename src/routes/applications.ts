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
  APP_STATUSES,
} from '../db/schema.js';
import { eq, desc, and } from 'drizzle-orm';
import { requireAuth, requireRole, type AppContext } from '../middleware.js';

const applicationsRouter = new Hono<AppContext>({ strict: false });

type AppStatus = typeof APP_STATUSES[number];

/** Strict stage machine — mirrors the master plan lifecycle diagram */
const TRANSITIONS: Record<AppStatus, AppStatus[]> = {
  applied:              ['in_review'],
  in_review:            ['shortlisted', 'rejected'],
  shortlisted:          ['interview_scheduled', 'rejected'],
  interview_scheduled:  ['hold', 'offer', 'no_offer'],
  hold:                 ['interview_scheduled', 'rejected'],
  offer:                [],
  no_offer:             [],
  rejected:             [],
};

export const STATUS_LABELS: Record<AppStatus, string> = {
  applied:              'Applied',
  in_review:            'In Review',
  shortlisted:          'Shortlisted',
  rejected:             'Rejected',
  interview_scheduled:  'Interview Scheduled',
  hold:                 'On Hold',
  offer:                'Offer Extended',
  no_offer:             'No Offer',
};

/* ─── Zod schemas ─── */
const createSchema = z.object({
  jobId:       z.number().int().positive(),
  candidateId: z.number().int().positive(),
  notes:       z.string().optional(),
});

const statusSchema = z.object({
  status: z.enum(APP_STATUSES),
  note:   z.string().optional(),
});

const notesSchema = z.object({ notes: z.string() });

/* ─── Helpers ─── */
async function enrichApplication(app: Record<string, unknown>) {
  const [cand] = await db
    .select({
      id: candidates.id, name: candidates.name, email: candidates.email,
      matchScore: candidates.matchScore, experience: candidates.experience,
      location: candidates.location, skills: candidates.skills,
    })
    .from(candidates)
    .where(eq(candidates.id, app.candidateId as number));

  const [job] = await db
    .select({ id: jobs.id, title: jobs.title, department: jobs.department })
    .from(jobs)
    .where(eq(jobs.id, app.jobId as number));

  return {
    ...app,
    candidate:          cand   ?? null,
    job:                job    ?? null,
    allowedTransitions: TRANSITIONS[app.status as AppStatus] ?? [],
    statusLabel:        STATUS_LABELS[app.status as AppStatus] ?? app.status,
  };
}

/* ═══════════════════════════════════════════════
   GET /applications?jobId=X
   All authenticated users can list applications.
═══════════════════════════════════════════════ */
applicationsRouter.get('/', requireAuth, async (c) => {
  try {
    const jobId = c.req.query('jobId');
    if (!jobId) return c.json({ error: 'jobId query param is required' }, 400);
    const jid = parseInt(jobId);
    if (isNaN(jid)) return c.json({ error: 'Invalid jobId' }, 400);

    const all = await db
      .select()
      .from(applications)
      .where(eq(applications.jobId, jid))
      .orderBy(desc(applications.createdAt));

    const enriched = await Promise.all(all.map(r => enrichApplication(r as Record<string, unknown>)));
    return c.json(enriched);
  } catch {
    return c.json({ error: 'Failed to fetch applications' }, 500);
  }
});

/* ═══════════════════════════════════════════════
   GET /applications/:id
═══════════════════════════════════════════════ */
applicationsRouter.get('/:id', requireAuth, async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const row = await db.select().from(applications).where(eq(applications.id, id)).limit(1);
    if (row.length === 0) return c.json({ error: 'Application not found' }, 404);

    return c.json(await enrichApplication(row[0] as Record<string, unknown>));
  } catch {
    return c.json({ error: 'Failed to fetch application' }, 500);
  }
});

/* ═══════════════════════════════════════════════
   POST /applications  — recruiter admin / staff only
═══════════════════════════════════════════════ */
applicationsRouter.post(
  '/',
  requireAuth,
  requireRole('recruiter_admin', 'recruited_staff'),
  zValidator('json', createSchema),
  async (c) => {
    try {
      const userId = c.get('userId') as number;
      const { jobId, candidateId, notes } = c.req.valid('json');

      // Duplicate guard
      const dup = await db
        .select({ id: applications.id })
        .from(applications)
        .where(and(eq(applications.jobId, jobId), eq(applications.candidateId, candidateId)))
        .limit(1);
      if (dup.length > 0) {
        return c.json({ error: 'Candidate is already assigned to this job' }, 409);
      }

      const created = await db.insert(applications).values({
        jobId,
        candidateId,
        status: 'applied',
        notes: notes ?? '',
        createdBy: userId,
      }).returning();

      // Seed initial history row
      await db.insert(applicationStageHistory).values({
        applicationId: created[0].id,
        fromStatus:    null,
        toStatus:      'applied',
        note:          'Application created',
        changedBy:     userId,
      });

      return c.json(await enrichApplication(created[0] as Record<string, unknown>), 201);
    } catch {
      return c.json({ error: 'Failed to create application' }, 500);
    }
  }
);

/* ═══════════════════════════════════════════════
   PATCH /applications/:id/status
   Any authenticated user in the org can advance the stage.
═══════════════════════════════════════════════ */
applicationsRouter.patch('/:id/status', requireAuth, zValidator('json', statusSchema), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const id     = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const { status: nextStatus, note } = c.req.valid('json');

    const row = await db.select().from(applications).where(eq(applications.id, id)).limit(1);
    if (row.length === 0) return c.json({ error: 'Application not found' }, 404);

    const currentStatus = row[0].status as AppStatus;
    const allowed       = TRANSITIONS[currentStatus] ?? [];

    if (!allowed.includes(nextStatus)) {
      return c.json({
        error:              `Invalid transition: ${currentStatus} → ${nextStatus}`,
        allowedTransitions: allowed,
      }, 400);
    }

    const now = new Date().toISOString();
    await db.update(applications)
      .set({ status: nextStatus, updatedAt: now })
      .where(eq(applications.id, id));

    await db.insert(applicationStageHistory).values({
      applicationId: id,
      fromStatus:    currentStatus,
      toStatus:      nextStatus,
      note:          note ?? '',
      changedBy:     userId,
    });

    const updated = await db.select().from(applications).where(eq(applications.id, id)).limit(1);
    return c.json(await enrichApplication(updated[0] as Record<string, unknown>));
  } catch {
    return c.json({ error: 'Failed to update status' }, 500);
  }
});

/* ═══════════════════════════════════════════════
   PATCH /applications/:id/notes
═══════════════════════════════════════════════ */
applicationsRouter.patch('/:id/notes', requireAuth, zValidator('json', notesSchema), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    const { notes } = c.req.valid('json');
    await db.update(applications).set({ notes, updatedAt: new Date().toISOString() }).where(eq(applications.id, id));
    return c.json({ message: 'Notes updated' });
  } catch {
    return c.json({ error: 'Failed to update notes' }, 500);
  }
});

/* ═══════════════════════════════════════════════
   GET /applications/:id/history
═══════════════════════════════════════════════ */
applicationsRouter.get('/:id/history', requireAuth, async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const rows = await db
      .select({
        id:            applicationStageHistory.id,
        applicationId: applicationStageHistory.applicationId,
        fromStatus:    applicationStageHistory.fromStatus,
        toStatus:      applicationStageHistory.toStatus,
        note:          applicationStageHistory.note,
        changedAt:     applicationStageHistory.changedAt,
        changedByName: users.name,
      })
      .from(applicationStageHistory)
      .leftJoin(users, eq(applicationStageHistory.changedBy, users.id))
      .where(eq(applicationStageHistory.applicationId, id))
      .orderBy(applicationStageHistory.changedAt);

    return c.json(rows.map(h => ({
      ...h,
      fromStatusLabel: h.fromStatus ? (STATUS_LABELS[h.fromStatus as AppStatus] ?? h.fromStatus) : null,
      toStatusLabel:   STATUS_LABELS[h.toStatus as AppStatus] ?? h.toStatus,
    })));
  } catch {
    return c.json({ error: 'Failed to fetch history' }, 500);
  }
});

/* ═══════════════════════════════════════════════
   DELETE /applications/:id  — recruiter admin only
═══════════════════════════════════════════════ */
applicationsRouter.delete('/:id', requireAuth, requireRole('recruiter_admin'), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const row = await db.select({ id: applications.id }).from(applications).where(eq(applications.id, id)).limit(1);
    if (row.length === 0) return c.json({ error: 'Application not found' }, 404);

    await db.delete(applicationStageHistory).where(eq(applicationStageHistory.applicationId, id));
    await db.delete(applications).where(eq(applications.id, id));
    return c.json({ message: 'Application deleted' });
  } catch {
    return c.json({ error: 'Failed to delete application' }, 500);
  }
});

export default applicationsRouter;
