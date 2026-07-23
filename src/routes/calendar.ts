import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import {
  accountPortalUsers,
  calendarEvents,
  interviews,
  candidates,
  users,
  jobs,
} from '../db/schema.js';
import { and, eq, inArray, isNull, or, gte, lte, ne } from 'drizzle-orm';
import { requireAuth, type AppContext, type UserRole } from '../middleware.js';
import { getAccessibleAccountIds, isOrgPortalRole } from '../lib/orgScope.js';

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
  jobId:         z.number().optional().nullable(),
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

async function interviewsAsCalendarEvents(
  visibleJobIds: number[],
  visibleCreatorIds: number[],
  redactCandidateDetails: boolean,
  from?: string,
  to?: string,
  jobId?: number,
) {
  if (visibleJobIds.length === 0 || visibleCreatorIds.length === 0) return [];

  const dateScope = and(
    from ? gte(interviews.startTime, from) : undefined,
    to ? lte(interviews.startTime, to) : undefined,
  );

  const interviewRows = await db
    .select({
      id: interviews.id,
      title: interviews.title,
      startTime: interviews.startTime,
      endTime: interviews.endTime,
      status: interviews.status,
      candidateId: interviews.candidateId,
      accountName: interviews.accountName,
      endClient: interviews.endClient,
      interviewerIds: interviews.interviewerIds,
      organizationId: interviews.organizationId,
      createdBy: interviews.createdBy,
      jobId: interviews.jobId,
    })
    .from(interviews)
    .where(
      and(
        inArray(interviews.jobId, visibleJobIds),
        inArray(interviews.createdBy, visibleCreatorIds),
        ne(interviews.status, 'cancelled'),
        jobId != null ? eq(interviews.jobId, jobId) : undefined,
        dateScope,
      ),
    );

  if (interviewRows.length === 0) return [];

  const candidateIds = [...new Set(interviewRows.map((row) => row.candidateId).filter(Boolean))];
  const candidateNameById = new Map<number, string>();
  if (candidateIds.length > 0 && !redactCandidateDetails) {
    const candRows = await db
      .select({ id: candidates.id, name: candidates.name })
      .from(candidates)
      .where(inArray(candidates.id, candidateIds));
    for (const row of candRows) candidateNameById.set(row.id, row.name);
  }

  const allInterviewerIds = [
    ...new Set(interviewRows.flatMap((row) => parseInterviewerIds(row.interviewerIds))),
  ];
  const interviewerNameById = new Map<number, string>();
  if (allInterviewerIds.length > 0 && !redactCandidateDetails) {
    const interviewerRows = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(inArray(users.id, allInterviewerIds));
    for (const row of interviewerRows) interviewerNameById.set(row.id, row.name);
  }

  return interviewRows.map((row) => {
    const interviewerIds = parseInterviewerIds(row.interviewerIds);
    const interviewerLabel = interviewerIds
      .map((id) => interviewerNameById.get(id))
      .filter(Boolean)
      .join(', ') || 'Unassigned';

    return {
      id: `interview-${row.id}`,
      title: row.title,
      startTime: row.startTime,
      endTime: row.endTime,
      color: row.status === 'completed' ? 'green' : 'purple',
      eventType: 'interview',
      candidateId: redactCandidateDetails ? null : row.candidateId,
      candidateName: redactCandidateDetails ? '' : (candidateNameById.get(row.candidateId) ?? ''),
      jobProfile: row.accountName || row.endClient || '',
      location: '',
      description: redactCandidateDetails ? 'Scheduled interview' : `Interviewers: ${interviewerLabel}`,
      meetingLink: '',
      isAllDay: 0,
      organizationId: row.organizationId,
      createdBy: row.createdBy,
      source: 'interview',
      interviewStatus: row.status,
    };
  });
}

async function getCalendarMemberIds(
  userId: number,
  orgId: number | null,
  role: UserRole | null,
  accountIds: number[],
): Promise<number[]> {
  if (isOrgPortalRole(role)) {
    if (accountIds.length === 0) return [userId];
    const rows = await db
      .select({ userId: accountPortalUsers.userId })
      .from(accountPortalUsers)
      .where(inArray(accountPortalUsers.accountId, accountIds));
    return [...new Set([userId, ...rows.map((row) => row.userId)])];
  }

  const rows = orgId == null
    ? await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, userId), eq(users.portalType, 'recruiter')))
    : await db
        .select({ id: users.id })
        .from(users)
        .where(and(
          eq(users.organizationId, orgId),
          eq(users.portalType, 'recruiter'),
        ));
  return rows.map((row) => row.id);
}

async function getVisibleJobIds(userId: number, orgId: number | null, role: UserRole | null) {
  const accountIds = await getAccessibleAccountIds(userId, orgId, role);
  const memberIds = await getCalendarMemberIds(userId, orgId, role, accountIds);
  const accountScope = accountIds.length > 0 ? inArray(jobs.accountId, accountIds) : undefined;
  const orphanScope = and(isNull(jobs.accountId), inArray(jobs.createdBy, memberIds));
  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(accountScope ? or(accountScope, orphanScope) : orphanScope);
  return rows.map((row) => row.id);
}

// GET /calendar — calendar events + scheduled interviews
calendarRouter.get('/', requireAuth, async (c) => {
  try {
    const userId  = c.get('userId') as number;
    const orgId   = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const from    = c.req.query('from');
    const to      = c.req.query('to');
    const jobIdParam = c.req.query('jobId');
    const jobId = jobIdParam ? parseInt(jobIdParam) : undefined;

    const accountIds = await getAccessibleAccountIds(userId, orgId, role);
    const memberIds = await getCalendarMemberIds(userId, orgId, role, accountIds);
    if (memberIds.length === 0) return c.json([]);
    const visibleJobIds = await getVisibleJobIds(userId, orgId, role);

    const dateScope = and(
      from ? gte(calendarEvents.startTime, from) : undefined,
      to ? lte(calendarEvents.startTime, to) : undefined,
    );

    const rows = isOrgPortalRole(role)
      ? await db.select().from(calendarEvents).where(
          and(
            inArray(calendarEvents.createdBy, memberIds),
            visibleJobIds.length > 0
              ? or(
                  inArray(calendarEvents.jobId, visibleJobIds),
                  isNull(calendarEvents.jobId),
                )
              : isNull(calendarEvents.jobId),
            jobId != null && !isNaN(jobId) ? eq(calendarEvents.jobId, jobId) : undefined,
            dateScope,
          ),
        )
      : await db.select().from(calendarEvents)
          .where(and(
            inArray(calendarEvents.createdBy, memberIds),
            jobId != null && !isNaN(jobId) ? eq(calendarEvents.jobId, jobId) : undefined,
            dateScope,
          ));

    const calendarOnly = rows.filter((e) => {
      if (e.jobId != null && !visibleJobIds.includes(e.jobId)) return false;
      return true;
    }).map((e) => isOrgPortalRole(role)
      ? {
          ...e,
          candidateId: null,
          candidateName: '',
          source: 'calendar',
        }
      : { ...e, source: 'calendar' });

    const interviewEvents = await interviewsAsCalendarEvents(
      visibleJobIds,
      memberIds,
      isOrgPortalRole(role),
      from,
      to,
      jobId != null && !isNaN(jobId) ? jobId : undefined,
    );

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
    const role = c.get('userRole') as UserRole | null;
    const b      = c.req.valid('json');
    if (b.jobId != null) {
      const visibleJobIds = await getVisibleJobIds(userId, orgId, role);
      if (!visibleJobIds.includes(b.jobId)) {
        return c.json({ error: 'Job not found or unauthorized' }, 403);
      }
    }

    const [created] = await db.insert(calendarEvents).values({
      title:         b.title,
      startTime:     b.startTime,
      endTime:       b.endTime,
      color:         b.color         ?? 'blue',
      eventType:     b.eventType     ?? 'general',
      candidateId:   b.candidateId   ?? null,
      candidateName: b.candidateName ?? '',
      jobProfile:    b.jobProfile    ?? '',
      jobId:         b.jobId         ?? null,
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
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
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
    if (b.jobId != null) {
      const visibleJobIds = await getVisibleJobIds(userId, orgId, role);
      if (!visibleJobIds.includes(b.jobId)) {
        return c.json({ error: 'Job not found or unauthorized' }, 403);
      }
    }
    const patch: Record<string, unknown> = {};
    if (b.title         != null) patch.title         = b.title;
    if (b.startTime     != null) patch.startTime     = b.startTime;
    if (b.endTime       != null) patch.endTime       = b.endTime;
    if (b.color         != null) patch.color         = b.color;
    if (b.eventType     != null) patch.eventType     = b.eventType;
    if (b.candidateId   !== undefined) patch.candidateId   = b.candidateId;
    if (b.candidateName != null) patch.candidateName = b.candidateName;
    if (b.jobProfile    != null) patch.jobProfile    = b.jobProfile;
    if (b.jobId         !== undefined) patch.jobId         = b.jobId;
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
