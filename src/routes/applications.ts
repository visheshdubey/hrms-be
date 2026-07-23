import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import {
  applications,
  applicationStageHistory,
  candidates,
  jobs,
  jobStages,
  users,
  APP_STATUSES,
} from '../db/schema.js';
import { eq, desc, and, inArray, sql } from 'drizzle-orm';
import { requireAuth, requireRole, type AppContext, type UserRole } from '../middleware.js';
import { canAccessJob, getOrgMemberIds } from '../lib/orgScope.js';
import { selectJobById } from '../lib/jobQueries.js';
import { isSchemaDriftError } from '../lib/schemaDrift.js';
import {
  backfillNullApplicationStages,
} from '../lib/applicationDefaults.js';
import { createNotification, createNotificationsForUsers } from '../lib/notifications.js';
import {
  ApplicationWriteConflictError,
  createApplicationsAtomically,
  transitionApplicationAtomically,
} from '../lib/application-writes.js';

const applicationsRouter = new Hono<AppContext>({ strict: false });

async function canAccessCandidates(
  candidateIds: number[],
  userId: number,
  orgId: number | null,
): Promise<boolean> {
  const uniqueIds = [...new Set(candidateIds)];
  if (uniqueIds.length === 0) return true;
  const memberIds = await getOrgMemberIds(orgId, userId);
  const rows = await db
    .select({ id: candidates.id })
    .from(candidates)
    .where(and(inArray(candidates.id, uniqueIds), inArray(candidates.createdBy, memberIds)));
  return rows.length === uniqueIds.length;
}

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
  offer:                'Hired',
  no_offer:             'No Offer',
};

/* ─── Zod schemas ─── */
const createSchema = z.object({
  jobId:       z.number().int().positive(),
  candidateId: z.number().int().positive(),
  notes:       z.string().optional(),
  assignedTo:  z.number().int().positive().optional().nullable(),
  jobStageId:  z.number().int().positive().optional().nullable(),
});

const bulkCreateSchema = z.object({
  jobId:         z.number().int().positive(),
  candidateIds:  z.array(z.number().int().positive()).min(1),
  notes:         z.string().optional(),
  assignedTo:    z.number().int().positive().optional().nullable(),
});

const statusSchema = z.object({
  status: z.enum(APP_STATUSES),
  note:   z.string().optional(),
});

const notesSchema = z.object({ notes: z.string() });

const assignmentSchema = z.object({
  assignedTo: z.number().int().positive(),
  jobStageId: z.number().int().positive().optional().nullable(),
  /** Manual Hire / Reject only — never inferred from “next round”. */
  closeAs: z.enum(['hired', 'rejected']).optional(),
  /** Re-enable a closed (hired/rejected) application into a chosen stage. */
  reopen: z.boolean().optional(),
  note: z.string().optional(),
});

function isTerminalAppStatus(status: string): boolean {
  return status === 'offer' || status === 'rejected' || status === 'no_offer';
}

/* ─── Helpers ─── */
function safeJsonParse(str: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(str || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

async function enrichApplication(app: Record<string, unknown>) {
  const [cand] = await db
    .select({
      id: candidates.id, name: candidates.name, email: candidates.email,
      matchScore: candidates.matchScore, experience: candidates.experience,
      location: candidates.location, skills: candidates.skills,
    })
    .from(candidates)
    .where(eq(candidates.id, app.candidateId as number));

  let job: { id: number; title: string; department: string; assignedTo: number | null } | null = null;
  try {
    const [row] = await db
      .select({ id: jobs.id, title: jobs.title, department: jobs.department, assignedTo: jobs.assignedTo })
      .from(jobs)
      .where(eq(jobs.id, app.jobId as number));
    job = row ?? null;
  } catch {
    const [row] = await db
      .select({ id: jobs.id, title: jobs.title, department: jobs.department })
      .from(jobs)
      .where(eq(jobs.id, app.jobId as number));
    job = row ? { ...row, assignedTo: null } : null;
  }

  let jobStage: {
    id: number;
    name: string;
    color: string;
    orderIndex: number;
    stageType?: string | null;
  } | null = null;
  if (app.jobStageId != null) {
    try {
      const [stage] = await db
        .select({
          id: jobStages.id,
          name: jobStages.name,
          color: jobStages.color,
          orderIndex: jobStages.orderIndex,
          stageType: jobStages.stageType,
        })
        .from(jobStages)
        .where(eq(jobStages.id, app.jobStageId as number))
        .limit(1);
      jobStage = stage ?? null;
    } catch {
      const [stage] = await db
        .select({
          id: jobStages.id,
          name: jobStages.name,
          orderIndex: jobStages.orderIndex,
        })
        .from(jobStages)
        .where(eq(jobStages.id, app.jobStageId as number))
        .limit(1);
      jobStage = stage ? { ...stage, color: '#6366f1', stageType: null } : null;
    }
  }

  let assignedToName: string | null = null;
  if (app.assignedTo != null) {
    const [assignee] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, app.assignedTo as number))
      .limit(1);
    assignedToName = assignee?.name ?? null;
  }

  return {
    ...app,
    candidate: cand
      ? {
          ...cand,
          skills: safeJsonParse(cand.skills),
        }
      : null,
    job:                  job    ?? null,
    jobStage,
    assignedToName,
    allowedTransitions: TRANSITIONS[app.status as AppStatus] ?? [],
    statusLabel:        STATUS_LABELS[app.status as AppStatus] ?? app.status,
  };
}

async function getJobIfAccessible(
  jobId: number,
  userId: number,
  orgId: number | null,
  role?: UserRole | string | null,
) {
  const [job] = await selectJobById(jobId);
  if (!job || !await canAccessJob(job, userId, orgId, role)) return null;
  return job;
}

async function selectApplicationsForJob(jobId: number) {
  try {
    return await db
      .select()
      .from(applications)
      .where(eq(applications.jobId, jobId))
      .orderBy(desc(applications.createdAt));
  } catch (error) {
    if (!isSchemaDriftError(error) && !String(error).toLowerCase().includes('failed query')) {
      // still try legacy shape
    }
    const rows = await db
      .select({
        id: applications.id,
        jobId: applications.jobId,
        candidateId: applications.candidateId,
        status: applications.status,
        notes: applications.notes,
        createdBy: applications.createdBy,
        createdAt: applications.createdAt,
        updatedAt: applications.updatedAt,
      })
      .from(applications)
      .where(eq(applications.jobId, jobId))
      .orderBy(desc(applications.createdAt));
    return rows.map((row) => ({
      ...row,
      assignedTo: null as number | null,
      jobStageId: null as number | null,
    }));
  }
}

async function getApplicationIfAccessible(
  applicationId: number,
  userId: number,
  orgId: number | null,
  role?: UserRole | string | null,
) {
  let row: Array<typeof applications.$inferSelect | Record<string, unknown>> = [];
  try {
    row = await db.select().from(applications).where(eq(applications.id, applicationId)).limit(1);
  } catch {
    const legacy = await db
      .select({
        id: applications.id,
        jobId: applications.jobId,
        candidateId: applications.candidateId,
        status: applications.status,
        notes: applications.notes,
        createdBy: applications.createdBy,
        createdAt: applications.createdAt,
        updatedAt: applications.updatedAt,
      })
      .from(applications)
      .where(eq(applications.id, applicationId))
      .limit(1);
    row = legacy.map((r) => ({ ...r, assignedTo: null, jobStageId: null }));
  }
  if (row.length === 0) return null;
  const job = await getJobIfAccessible(row[0].jobId as number, userId, orgId, role);
  if (!job) return null;
  return row[0] as typeof applications.$inferSelect;
}

async function resolveRequiredAssignee(
  jobId: number,
  assignedTo?: number | null,
  fallbackUserId?: number,
): Promise<number> {
  const isValidRecruiterAssignee = async (candidateUserId: number) => {
    if (fallbackUserId == null) return false;
    const [actor] = await db
      .select({ organizationId: users.organizationId })
      .from(users)
      .where(eq(users.id, fallbackUserId))
      .limit(1);
    const [assignee] = await db
      .select({ organizationId: users.organizationId, role: users.role, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, candidateUserId))
      .limit(1);
    return Boolean(
      actor
      && assignee
      && actor.organizationId === assignee.organizationId
      && assignee.isActive === 1
      && (assignee.role === 'recruiter_admin' || assignee.role === 'recruited_staff'),
    );
  };

  if (assignedTo != null && assignedTo > 0) {
    if (!await isValidRecruiterAssignee(assignedTo)) throw new Error('ASSIGNEE_INVALID');
    return assignedTo;
  }

  try {
    const [job] = await db
      .select({ assignedTo: jobs.assignedTo })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);
    if (
      job?.assignedTo != null
      && job.assignedTo > 0
      && await isValidRecruiterAssignee(job.assignedTo)
    ) return job.assignedTo;
  } catch {
    // assigned_to may be missing until ensureProdSchema runs
  }

  // Prefer job owner; otherwise the recruiter performing the assign so Search → job works E2E.
  if (
    fallbackUserId != null
    && fallbackUserId > 0
    && await isValidRecruiterAssignee(fallbackUserId)
  ) return fallbackUserId;

  throw new Error('ASSIGNMENT_REQUIRED');
}

async function validateApplicationRelationships(params: {
  jobId: number;
  orgId: number | null;
  userId: number;
  assignedTo: number;
  jobStageId?: number | null;
  allowTerminalStage?: boolean;
}): Promise<'INVALID_ASSIGNEE' | 'INVALID_STAGE' | null> {
  const [assignee] = await db
    .select({ organizationId: users.organizationId, role: users.role, isActive: users.isActive })
    .from(users)
    .where(eq(users.id, params.assignedTo))
    .limit(1);
  if (
    !assignee
    || assignee.organizationId !== params.orgId
    || assignee.isActive !== 1
    || (assignee.role !== 'recruiter_admin' && assignee.role !== 'recruited_staff')
  ) return 'INVALID_ASSIGNEE';
  if (params.jobStageId != null) {
    const [stage] = await db
      .select({ id: jobStages.id, stageType: jobStages.stageType })
      .from(jobStages)
      .where(and(
        eq(jobStages.id, params.jobStageId),
        eq(jobStages.jobId, params.jobId),
      ))
      .limit(1);
    if (!stage || (!params.allowTerminalStage
      && (stage.stageType === 'hired' || stage.stageType === 'rejected'))) {
      return 'INVALID_STAGE';
    }
  }
  return null;
}

async function notifyApplicationCreated(params: {
  applicationId: number;
  jobId: number;
  candidateId: number;
  userId: number;
  assignedTo: number;
}) {
  const [job] = await db
    .select({ title: jobs.title, createdBy: jobs.createdBy })
    .from(jobs)
    .where(eq(jobs.id, params.jobId))
    .limit(1);
  const [candidate] = await db
    .select({ name: candidates.name })
    .from(candidates)
    .where(eq(candidates.id, params.candidateId))
    .limit(1);

  const candidateName = candidate?.name?.trim() || `Candidate #${params.candidateId}`;
  const jobTitle = job?.title?.trim() || `Job #${params.jobId}`;

  await createNotificationsForUsers(
    [params.assignedTo, job?.createdBy, params.userId],
    {
      title: 'New application received',
      body: `${candidateName} was added to ${jobTitle}.`,
      type: 'application',
      relatedId: params.applicationId,
      relatedType: 'application',
    },
  );
}

function filterEnrichedApplications(
  rows: Awaited<ReturnType<typeof enrichApplication>>[],
  filters: { stageId?: string; email?: string; q?: string },
) {
  let result = rows;

  if (filters.stageId) {
    const sid = parseInt(filters.stageId, 10);
    if (!isNaN(sid)) {
      result = result.filter((row) => (row as { jobStageId?: number | null }).jobStageId === sid);
    }
  }

  if (filters.email?.trim()) {
    const needle = filters.email.trim().toLowerCase();
    result = result.filter((row) => row.candidate?.email?.toLowerCase().includes(needle));
  }

  if (filters.q?.trim()) {
    const needle = filters.q.trim().toLowerCase();
    result = result.filter((row) => {
      const candidate = row.candidate;
      const record = row as {
        id?: number;
        candidateId?: number;
      };
      return (
        String(record.id).includes(needle)
        || String(record.candidateId).includes(needle)
        || candidate?.name?.toLowerCase().includes(needle)
        || candidate?.email?.toLowerCase().includes(needle)
      );
    });
  }

  return result;
}

function redactApplicationForClient(
  app: Awaited<ReturnType<typeof enrichApplication>>,
  role: UserRole | null,
) {
  if (role !== 'org_admin' && role !== 'org_staff') return app;
  const candidate = app.candidate;
  const visible: Record<string, unknown> = { ...app };
  delete visible.notes;
  delete visible.assignedTo;
  delete visible.assignedToName;
  delete visible.candidate;
  delete visible.allowedTransitions;
  return {
    ...visible,
    candidate: candidate ? { id: candidate.id, name: candidate.name } : null,
    allowedTransitions: [],
  };
}

/* ═══════════════════════════════════════════════
   GET /applications?jobId=X
   All authenticated users can list applications.
═══════════════════════════════════════════════ */
applicationsRouter.get('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const jobId = c.req.query('jobId');
    if (!jobId) return c.json({ error: 'jobId query param is required' }, 400);
    const jid = parseInt(jobId);
    if (isNaN(jid)) return c.json({ error: 'Invalid jobId' }, 400);

    const job = await getJobIfAccessible(jid, userId, orgId, role);
    if (!job) return c.json({ error: 'Job not found' }, 404);

    await backfillNullApplicationStages(jid);

    const all = await selectApplicationsForJob(jid);

    const enriched = await Promise.all(all.map((r) => enrichApplication(r as Record<string, unknown>)));
    const filtered = filterEnrichedApplications(enriched, {
      stageId: c.req.query('stageId'),
      email: c.req.query('email'),
      q: c.req.query('q'),
    });

    return c.json(filtered.map((app) => redactApplicationForClient(app, role)));
  } catch {
    return c.json({ error: 'Failed to fetch applications' }, 500);
  }
});

/* ═══════════════════════════════════════════════
   POST /applications/bulk
═══════════════════════════════════════════════ */
applicationsRouter.post(
  '/bulk',
  requireAuth,
  requireRole('recruiter_admin', 'recruited_staff'),
  zValidator('json', bulkCreateSchema),
  async (c) => {
    try {
      const userId = c.get('userId') as number;
      const orgId = c.get('organizationId') as number | null;
      const role = c.get('userRole') as UserRole | null;
      const { jobId, candidateIds, notes, assignedTo } = c.req.valid('json');

      const job = await getJobIfAccessible(jobId, userId, orgId, role);
      if (!job) return c.json({ error: 'Job not found' }, 404);
      if (!(await canAccessCandidates(candidateIds, userId, orgId))) {
        return c.json({ error: 'One or more candidates were not found' }, 404);
      }

      if (job.status !== 'submission_in_progress') {
        return c.json(
          { error: 'Only Active jobs accept applications. Set the job status to Active first.' },
          400,
        );
      }

      let resolvedAssignee: number;
      try {
        resolvedAssignee = await resolveRequiredAssignee(jobId, assignedTo, userId);
      } catch {
        return c.json({ error: 'Assign a job owner or staff member before bulk assigning' }, 400);
      }
      const relationshipError = await validateApplicationRelationships({
        jobId,
        orgId,
        userId,
        assignedTo: resolvedAssignee,
      });
      if (relationshipError === 'INVALID_ASSIGNEE') {
        return c.json({ error: 'Assignee must be an active member of your organization' }, 400);
      }

      const result = await createApplicationsAtomically({
        jobId,
        userId,
        assignedTo: resolvedAssignee,
        applications: candidateIds.map((candidateId) => ({ candidateId, notes })),
      });
      const created = await Promise.all(
        result.created.map((row) => enrichApplication(row as Record<string, unknown>)),
      );
      const skipped = result.skipped.map((candidateId) => ({
        candidateId,
        reason: 'already_assigned',
      }));
      await Promise.all(result.created.map((row) => notifyApplicationCreated({
        applicationId: row.id,
        jobId,
        candidateId: row.candidateId,
        userId,
        assignedTo: resolvedAssignee,
      })));

      return c.json({
        created,
        skipped,
        createdCount: created.length,
        skippedCount: skipped.length,
      }, 201);
    } catch {
      return c.json({ error: 'Failed to bulk create applications' }, 500);
    }
  },
);

/* ═══════════════════════════════════════════════
   GET /applications/:id
═══════════════════════════════════════════════ */
applicationsRouter.get('/:id', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const row = await getApplicationIfAccessible(id, userId, orgId, role);
    if (!row) return c.json({ error: 'Application not found' }, 404);

    return c.json(redactApplicationForClient(
      await enrichApplication(row as Record<string, unknown>),
      role,
    ));
  } catch {
    return c.json({ error: 'Failed to fetch application' }, 404);
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
      const orgId = c.get('organizationId') as number | null;
      const role = c.get('userRole') as UserRole | null;
      const body = c.req.valid('json');
      const { jobId, candidateId, notes, assignedTo, jobStageId } = body;

      const job = await getJobIfAccessible(jobId, userId, orgId, role);
      if (!job) return c.json({ error: 'Job not found' }, 404);
      if (!(await canAccessCandidates([candidateId], userId, orgId))) {
        return c.json({ error: 'Candidate not found' }, 404);
      }

      if (job.status !== 'submission_in_progress') {
        return c.json(
          { error: 'Only Active jobs accept applications. Set the job status to Active first.' },
          400,
        );
      }

      const resolvedAssignee = await resolveRequiredAssignee(jobId, assignedTo, userId);
      const relationshipError = await validateApplicationRelationships({
        jobId,
        orgId,
        userId,
        assignedTo: resolvedAssignee,
        jobStageId,
      });
      if (relationshipError === 'INVALID_ASSIGNEE') {
        return c.json({ error: 'Assignee must be an active member of your organization' }, 400);
      }
      if (relationshipError === 'INVALID_STAGE') {
        return c.json({ error: 'Stage not found for this job' }, 400);
      }

      const result = await createApplicationsAtomically({
        jobId,
        userId,
        assignedTo: resolvedAssignee,
        jobStageId,
        applications: [{ candidateId, notes }],
      });
      if (result.created.length === 0) {
        return c.json({ error: 'Candidate is already assigned to this job' }, 409);
      }

      const created = result.created[0];
      await notifyApplicationCreated({
        applicationId: created.id,
        jobId,
        candidateId,
        userId,
        assignedTo: resolvedAssignee,
      });
      return c.json(await enrichApplication(created as Record<string, unknown>), 201);
    } catch (error) {
      if (error instanceof Error && error.message === 'ASSIGNMENT_REQUIRED') {
        return c.json({ error: 'Assign a job owner before creating applications' }, 400);
      }
      if (error instanceof Error && error.message === 'ASSIGNEE_INVALID') {
        return c.json({ error: 'Assignee must be an active recruiter in this workspace' }, 400);
      }
      return c.json({ error: 'Failed to create application' }, 500);
    }
  },
);

/* ═══════════════════════════════════════════════
   PATCH /applications/:id/assignment
═══════════════════════════════════════════════ */
applicationsRouter.patch(
  '/:id/assignment',
  requireAuth,
  requireRole('recruiter_admin', 'recruited_staff'),
  zValidator('json', assignmentSchema),
  async (c) => {
    try {
      const userId = c.get('userId') as number;
      const orgId = c.get('organizationId') as number | null;
      const role = c.get('userRole') as UserRole | null;
      const id = parseInt(c.req.param('id'));
      if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

      const row = await getApplicationIfAccessible(id, userId, orgId, role);
      if (!row) return c.json({ error: 'Application not found' }, 404);

      const body = c.req.valid('json');
      const relationshipError = await validateApplicationRelationships({
        jobId: row.jobId,
        orgId,
        userId,
        assignedTo: body.assignedTo,
        jobStageId: body.jobStageId,
        allowTerminalStage: Boolean(body.closeAs),
      });
      if (relationshipError === 'INVALID_ASSIGNEE') {
        return c.json({ error: 'Assignee must be an active member of your organization' }, 400);
      }
      if (relationshipError === 'INVALID_STAGE') {
        return c.json({ error: 'Stage not found for this job' }, 400);
      }
      const currentStatus = row.status as AppStatus;

      let currentStageType: string | null = null;
      if (row.jobStageId != null) {
        try {
          const [cur] = await db
            .select({ stageType: jobStages.stageType })
            .from(jobStages)
            .where(eq(jobStages.id, row.jobStageId as number))
            .limit(1);
          currentStageType = cur?.stageType ?? null;
        } catch {
          currentStageType = null;
        }
      }

      const isClosed =
        isTerminalAppStatus(currentStatus) ||
        currentStageType === 'hired' ||
        currentStageType === 'rejected';

      /* ── Re-open closed application into a chosen open stage ── */
      if (body.reopen) {
        if (!isClosed) {
          return c.json({ error: 'Application is not closed' }, 400);
        }
        if (body.jobStageId == null) {
          return c.json({ error: 'Select a stage to place the candidate in' }, 400);
        }
        const [stage] = await db
          .select({ id: jobStages.id, name: jobStages.name, stageType: jobStages.stageType })
          .from(jobStages)
          .where(and(eq(jobStages.id, body.jobStageId), eq(jobStages.jobId, row.jobId)))
          .limit(1);
        if (!stage) return c.json({ error: 'Stage not found for this job' }, 400);
        if (stage.stageType === 'hired' || stage.stageType === 'rejected') {
          return c.json({ error: 'Re-open stage must be an open pipeline round (not Hired/Rejected)' }, 400);
        }

        const nextStatus: AppStatus = 'in_review';

        const updated = await transitionApplicationAtomically({
          applicationId: id,
          candidateId: row.candidateId,
          expectedStatus: currentStatus,
          expectedStageId: (row.jobStageId as number | null) ?? null,
          nextStatus,
          nextStageId: stage.id,
          assignedTo: body.assignedTo,
          note: body.note?.trim() || `Reopened → ${stage.name}`,
          changedBy: userId,
          candidateStatus: 'In Review',
        });
        return c.json(await enrichApplication(updated as Record<string, unknown>));
      }

      if (isClosed) {
        return c.json(
          {
            error:
              'Application is closed (hired or rejected). Re-open it and choose a stage to continue.',
          },
          409,
        );
      }

      /* ── Manual Hire / Reject (closes application) ── */
      if (body.closeAs) {
        const targetType = body.closeAs === 'hired' ? 'hired' : 'rejected';
        let stage:
          | { id: number; name: string; stageType: string }
          | undefined;

        if (body.jobStageId != null) {
          const [picked] = await db
            .select({ id: jobStages.id, name: jobStages.name, stageType: jobStages.stageType })
            .from(jobStages)
            .where(and(eq(jobStages.id, body.jobStageId), eq(jobStages.jobId, row.jobId)))
            .limit(1);
          if (!picked || picked.stageType !== targetType) {
            return c.json({ error: `Selected stage is not a ${targetType} stage` }, 400);
          }
          stage = picked;
        } else {
          const [found] = await db
            .select({ id: jobStages.id, name: jobStages.name, stageType: jobStages.stageType })
            .from(jobStages)
            .where(and(eq(jobStages.jobId, row.jobId), eq(jobStages.stageType, targetType)))
            .limit(1);
          stage = found;
        }

        if (!stage) {
          return c.json({ error: `No ${targetType} stage configured for this job` }, 400);
        }

        const nextStatus: AppStatus = body.closeAs === 'hired' ? 'offer' : 'rejected';
        const prevStageId = (row.jobStageId as number | null) ?? null;
        const historyNote =
          body.note?.trim() ||
          (body.closeAs === 'hired'
            ? `Hired from stage #${prevStageId ?? 'n/a'} → ${stage.name}`
            : `Rejected from stage #${prevStageId ?? 'n/a'} → ${stage.name}`);

        const updated = await transitionApplicationAtomically({
          applicationId: id,
          candidateId: row.candidateId,
          expectedStatus: currentStatus,
          expectedStageId: prevStageId,
          nextStatus,
          nextStageId: stage.id,
          assignedTo: body.assignedTo,
          note: historyNote,
          changedBy: userId,
          candidateStatus: body.closeAs === 'hired' ? 'Hired' : 'Rejected',
        });

        const notifyUserId = (body.assignedTo ?? row.assignedTo) as number | null;
        if (notifyUserId) {
          await createNotification({
            userId: notifyUserId,
            title: body.closeAs === 'hired' ? 'Candidate hired' : 'Candidate rejected',
            body: `Application #${id} marked as ${body.closeAs}.`,
            type: 'stage_change',
            relatedId: id,
            relatedType: 'application',
          });
        }

        return c.json(await enrichApplication(updated as Record<string, unknown>));
      }

      /* ── Normal round move / assignee update (never auto Hire/Reject) ── */
      let transitionNote = body.note?.trim() || '';
      if (body.jobStageId !== undefined) {
        if (body.jobStageId != null) {
          const [stage] = await db
            .select({ id: jobStages.id, name: jobStages.name, stageType: jobStages.stageType })
            .from(jobStages)
            .where(and(eq(jobStages.id, body.jobStageId), eq(jobStages.jobId, row.jobId)))
            .limit(1);
          if (!stage) return c.json({ error: 'Stage not found for this job' }, 400);

          if (stage.stageType === 'hired' || stage.stageType === 'rejected') {
            return c.json(
              {
                error:
                  'Hired and Rejected require the Hire / Reject buttons — they cannot be reached via round moves.',
              },
              400,
            );
          }

          if (body.jobStageId !== row.jobStageId) {
            transitionNote ||= `Moved to ${stage.name}`;
          }
        } else {
          transitionNote ||= 'Removed from pipeline stage';
        }
      }

      const updated = await transitionApplicationAtomically({
        applicationId: id,
        candidateId: row.candidateId,
        expectedStatus: currentStatus,
        expectedStageId: (row.jobStageId as number | null) ?? null,
        nextStageId: body.jobStageId,
        assignedTo: body.assignedTo,
        note: transitionNote,
        changedBy: userId,
      });

      if (body.assignedTo != null && body.assignedTo !== row.assignedTo) {
        await createNotification({
          userId: body.assignedTo,
          title: 'Application assigned to you',
          body: `You were assigned application #${id}.`,
          type: 'application',
          relatedId: id,
          relatedType: 'application',
        });
      }

      if (body.jobStageId !== undefined && body.jobStageId !== row.jobStageId) {
        const notifyUserId = (body.assignedTo ?? row.assignedTo) as number | null;
        if (notifyUserId) {
          await createNotification({
            userId: notifyUserId,
            title: 'Application stage updated',
            body: `Application #${id} moved to a new pipeline stage.`,
            type: 'stage_change',
            relatedId: id,
            relatedType: 'application',
          });
        }
      }

      return c.json(await enrichApplication(updated as Record<string, unknown>));
    } catch (error) {
      if (error instanceof ApplicationWriteConflictError) {
        return c.json({
          error: 'Application changed concurrently. Refresh and retry your action.',
        }, 409);
      }
      return c.json({ error: 'Failed to update assignment' }, 500);
    }
  },
);

/* ═══════════════════════════════════════════════
   PATCH /applications/:id/status
   Any authenticated user in the org can advance the stage.
═══════════════════════════════════════════════ */
applicationsRouter.patch(
  '/:id/status',
  requireAuth,
  requireRole('recruiter_admin', 'recruited_staff'),
  zValidator('json', statusSchema),
  async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const id     = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const { status: nextStatus, note } = c.req.valid('json');

    const row = await getApplicationIfAccessible(id, userId, orgId, role);
    if (!row) return c.json({ error: 'Application not found' }, 404);

    const currentStatus = row.status as AppStatus;
    if (isTerminalAppStatus(currentStatus)) {
      return c.json(
        {
          error:
            'Application is closed (hired or rejected). Re-open it and choose a stage to continue.',
        },
        409,
      );
    }

    const allowed       = TRANSITIONS[currentStatus] ?? [];

    if (!allowed.includes(nextStatus)) {
      return c.json({
        error:              `Invalid transition: ${currentStatus} → ${nextStatus}`,
        allowedTransitions: allowed,
      }, 400);
    }

    const updated = await transitionApplicationAtomically({
      applicationId: id,
      candidateId: row.candidateId,
      expectedStatus: currentStatus,
      expectedStageId: (row.jobStageId as number | null) ?? null,
      nextStatus,
      note: note ?? '',
      changedBy: userId,
    });

    if (row.assignedTo) {
      await createNotification({
        userId: row.assignedTo as number,
        title: 'Application status changed',
        body: `Application #${id}: ${currentStatus} → ${nextStatus}.`,
        type: 'stage_change',
        relatedId: id,
        relatedType: 'application',
      });
    }

    return c.json(await enrichApplication(updated as Record<string, unknown>));
  } catch (error) {
    if (error instanceof ApplicationWriteConflictError) {
      return c.json({
        error: 'Application changed concurrently. Refresh and retry your action.',
      }, 409);
    }
    return c.json({ error: 'Failed to update status' }, 500);
  }
  },
);

/* ═══════════════════════════════════════════════
   PATCH /applications/:id/notes
═══════════════════════════════════════════════ */
applicationsRouter.patch(
  '/:id/notes',
  requireAuth,
  requireRole('recruiter_admin', 'recruited_staff'),
  zValidator('json', notesSchema),
  async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const row = await getApplicationIfAccessible(id, userId, orgId, role);
    if (!row) return c.json({ error: 'Application not found' }, 404);

    const { notes } = c.req.valid('json');
    await db.update(applications).set({ notes, updatedAt: new Date().toISOString() }).where(eq(applications.id, id));
    return c.json({ message: 'Notes updated' });
  } catch {
    return c.json({ error: 'Failed to update notes' }, 500);
  }
  },
);

/* ═══════════════════════════════════════════════
   GET /applications/:id/history
═══════════════════════════════════════════════ */
applicationsRouter.get('/:id/history', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const row = await getApplicationIfAccessible(id, userId, orgId, role);
    if (!row) return c.json({ error: 'Application not found' }, 404);

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
      ...(role === 'org_admin' || role === 'org_staff' ? { note: '' } : {}),
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
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const row = await getApplicationIfAccessible(id, userId, orgId, role);
    if (!row) return c.json({ error: 'Application not found' }, 404);

    await db.transaction(async (tx) => {
      await tx.delete(applicationStageHistory).where(eq(applicationStageHistory.applicationId, id));
      await tx.delete(applications).where(eq(applications.id, id));
      await tx.update(jobs)
        .set({
          applicants: sql`greatest(0, coalesce(${jobs.applicants}, 0) - 1)`,
        })
        .where(eq(jobs.id, row.jobId));
    });
    return c.json({ message: 'Application deleted' });
  } catch {
    return c.json({ error: 'Failed to delete application' }, 500);
  }
});

export default applicationsRouter;
