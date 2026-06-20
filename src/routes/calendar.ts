import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import { calendarEvents, interviews, candidates, users } from '../db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import { requireAuth, type AppContext } from '../middleware.js';

const calendarRouter = new Hono<AppContext>({ strict: false });

const eventSchema = z.object({
  title:         z.string().min(1),
  startTime:     z.string(),
  endTime:       z.string(),
  color:         z.string().optional(),
  eventType:     z.string().optional(),
  candidateId:   z.number().optional().nullable(),
  candidateName: z.string().optional(),
  jobProfile:    z.string().optional(),
  location:      z.string().optional(),
  description:   z.string().optional(),
  meetingLink:   z.string().optional(),
  isAllDay:      z.boolean().optional(),
});

function parseInterviewerIds(json: string | null | undefined): number[] {
  try {
    const parsed = JSON.parse(json ?? '[]');
    return Array.isArray(parsed) ? parsed.map(Number).filter(Boolean) : [];
  } catch {
    return [];
  }
}

async function interviewsAsCalendarEvents(orgId: number | null, from?: string, to?: string) {
  let interviewRows = await db.select().from(interviews);
  if (orgId != null) {
    interviewRows = interviewRows.filter((row) => row.organizationId === orgId);
  }

  const filtered = interviewRows.filter((row) => {
    if (row.status === 'cancelled') return false;
    if (from && row.startTime < from) return false;
    if (to && row.startTime > to) return false;
    return true;
  });

  const events = await Promise.all(
    filtered.map(async (row) => {
      const [cand] = await db
        .select({ id: candidates.id, name: candidates.name })
        .from(candidates)
        .where(eq(candidates.id, row.candidateId))
        .limit(1);

      const interviewerIds = parseInterviewerIds(row.interviewerIds);
      let interviewerNames: string[] = [];
      if (interviewerIds.length) {
        const interviewers = await db
          .select({ name: users.name })
          .from(users)
          .where(inArray(users.id, interviewerIds));
        interviewerNames = interviewers.map((u) => u.name);
      }

      const interviewerLabel = interviewerNames.length
        ? interviewerNames.join(', ')
        : 'Unassigned';

      return {
        id: `interview-${row.id}`,
        title: row.title,
        startTime: row.startTime,
        endTime: row.endTime,
        color: row.status === 'completed' ? 'green' : 'purple',
        eventType: 'interview',
        candidateId: row.candidateId,
        candidateName: cand?.name ?? '',
        jobProfile: row.accountName || row.endClient || '',
        location: '',
        description: `Interviewers: ${interviewerLabel}`,
        meetingLink: '',
        isAllDay: 0,
        organizationId: row.organizationId,
        createdBy: row.createdBy,
        source: 'interview',
        interviewStatus: row.status,
      };
    }),
  );

  return events;
}

// GET /calendar — calendar events + scheduled interviews
calendarRouter.get('/', requireAuth, async (c) => {
  try {
    const userId  = c.get('userId') as number;
    const orgId   = c.get('organizationId') as number | null;
    const from    = c.req.query('from');
    const to      = c.req.query('to');

    let memberIds: number[] = [userId];
    if (orgId != null) {
      const members = await db.select({ id: users.id }).from(users).where(eq(users.organizationId, orgId));
      memberIds = members.map((u: { id: number }) => u.id);
    }
    if (memberIds.length === 0) return c.json([]);

    const rows = await db.select().from(calendarEvents)
      .where(inArray(calendarEvents.createdBy, memberIds));

    const calendarOnly = rows.filter((e) => {
      if (from && e.startTime < from) return false;
      if (to && e.startTime > to) return false;
      return true;
    }).map((e) => ({ ...e, source: 'calendar' }));

    const interviewEvents = await interviewsAsCalendarEvents(orgId, from, to);

    return c.json([...calendarOnly, ...interviewEvents]);
  } catch (err) {
    console.error('[calendar] GET failed:', err);
    return c.json([]);
  }
});

// POST /calendar — create event
calendarRouter.post('/', requireAuth, zValidator('json', eventSchema), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId  = c.get('organizationId') as number | null;
    const b      = c.req.valid('json');

    const [created] = await db.insert(calendarEvents).values({
      title:         b.title,
      startTime:     b.startTime,
      endTime:       b.endTime,
      color:         b.color         ?? 'blue',
      eventType:     b.eventType     ?? 'general',
      candidateId:   b.candidateId   ?? null,
      candidateName: b.candidateName ?? '',
      jobProfile:    b.jobProfile    ?? '',
      location:      b.location      ?? '',
      description:   b.description   ?? '',
      meetingLink:   b.meetingLink   ?? '',
      isAllDay:      b.isAllDay ? 1 : 0,
      organizationId: orgId,
      createdBy:     userId,
    }).returning();

    return c.json(created, 201);
  } catch {
    return c.json({ error: 'Failed to create event' }, 500);
  }
});

// PUT /calendar/:id — update event
calendarRouter.put('/:id', requireAuth, zValidator('json', eventSchema.partial()), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const idParam = c.req.param('id');
    if (idParam.startsWith('interview-')) {
      return c.json({ error: 'Interview events are managed from the Interviews module' }, 403);
    }

    const id     = parseInt(idParam);
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const existing = await db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).limit(1);
    if (!existing.length) return c.json({ error: 'Event not found' }, 404);
    if (existing[0].createdBy !== userId) return c.json({ error: 'Unauthorized' }, 403);

    const b = c.req.valid('json');
    const patch: Record<string, unknown> = {};
    if (b.title         != null) patch.title         = b.title;
    if (b.startTime     != null) patch.startTime     = b.startTime;
    if (b.endTime       != null) patch.endTime       = b.endTime;
    if (b.color         != null) patch.color         = b.color;
    if (b.eventType     != null) patch.eventType     = b.eventType;
    if (b.candidateId   !== undefined) patch.candidateId   = b.candidateId;
    if (b.candidateName != null) patch.candidateName = b.candidateName;
    if (b.jobProfile    != null) patch.jobProfile    = b.jobProfile;
    if (b.location      != null) patch.location      = b.location;
    if (b.description   != null) patch.description   = b.description;
    if (b.meetingLink   != null) patch.meetingLink   = b.meetingLink;
    if (b.isAllDay      !== undefined) patch.isAllDay = b.isAllDay ? 1 : 0;

    const [updated] = await db.update(calendarEvents).set(patch as any).where(eq(calendarEvents.id, id)).returning();
    return c.json(updated);
  } catch {
    return c.json({ error: 'Failed to update event' }, 500);
  }
});

// DELETE /calendar/:id
calendarRouter.delete('/:id', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const idParam = c.req.param('id');
    if (idParam.startsWith('interview-')) {
      return c.json({ error: 'Interview events are managed from the Interviews module' }, 403);
    }

    const id     = parseInt(idParam);
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const existing = await db.select().from(calendarEvents).where(eq(calendarEvents.id, id)).limit(1);
    if (!existing.length) return c.json({ error: 'Event not found' }, 404);
    if (existing[0].createdBy !== userId) return c.json({ error: 'Unauthorized' }, 403);

    await db.delete(calendarEvents).where(eq(calendarEvents.id, id));
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'Failed to delete event' }, 500);
  }
});

export default calendarRouter;
