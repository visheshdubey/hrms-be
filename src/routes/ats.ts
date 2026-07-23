import { Hono } from 'hono';
import { and, desc, eq, gte, ilike, or } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import { candidateJobScores, candidateResumes, candidates, jobs, users } from '../db/schema.js';
import { persistCandidateJobScore } from '../lib/candidate-job-scores.js';
import { canAccessByCreator, canAccessJob } from '../lib/orgScope.js';
import { AtsPythonError } from '../lib/ats-python-client.js';
import { requireAuth, requireRecruiter, type AppContext } from '../middleware.js';

const atsRouter = new Hono<AppContext>({ strict: false });

const scoreSchema = z.object({
  candidateId: z.number().int().positive(),
  jobId: z.number().int().positive(),
  resumeId: z.number().int().positive().optional(),
});

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function scoreDto(row: typeof candidateJobScores.$inferSelect, extra: Record<string, unknown> = {}) {
  return {
    id: row.id,
    candidateId: row.candidateId,
    resumeId: row.resumeId,
    jobId: row.jobId,
    totalScore: row.totalScore,
    score: row.totalScore,
    status: 'completed',
    components: parseJson(row.components, {}),
    matchedRequirements: parseJson(row.matchedRequirements, []),
    missingRequirements: parseJson(row.missingRequirements, []),
    warnings: parseJson(row.warnings, []),
    resumeHash: row.resumeHash,
    jobHash: row.jobHash,
    algorithmVersion: row.algorithmVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...extra,
  };
}

atsRouter.post('/score', requireAuth, requireRecruiter, zValidator('json', scoreSchema), async (c) => {
  try {
    const { candidateId, jobId, resumeId } = c.req.valid('json');
    const userId = c.get('userId');
    const orgId = c.get('organizationId');
    const role = c.get('userRole');

    const [[candidate], [job]] = await Promise.all([
      db.select().from(candidates).where(eq(candidates.id, candidateId)).limit(1),
      db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1),
    ]);
    if (!candidate || !(await canAccessByCreator(orgId, userId, candidate.createdBy))) {
      return c.json({ error: 'Candidate not found' }, 404);
    }
    if (!job || !(await canAccessJob(job, userId, orgId, role))) {
      return c.json({ error: 'Job not found' }, 404);
    }

    const resumeRows = resumeId
      ? await db.select().from(candidateResumes).where(and(
          eq(candidateResumes.id, resumeId),
          eq(candidateResumes.candidateId, candidateId),
        )).limit(1)
      : await db.select().from(candidateResumes).where(and(
          eq(candidateResumes.candidateId, candidateId),
          eq(candidateResumes.parseStatus, 'parsed'),
        )).orderBy(desc(candidateResumes.createdAt), desc(candidateResumes.id)).limit(1);
    const resume = resumeRows[0];
    if (!resume || !(await canAccessByCreator(orgId, userId, resume.createdBy))) {
      return c.json({ error: 'Parsed resume not found for candidate' }, 404);
    }
    if (resume.parseStatus !== 'parsed' || !resume.extractedText) {
      return c.json({ error: 'Resume has not been parsed successfully', parseStatus: resume.parseStatus }, 409);
    }

    const saved = await persistCandidateJobScore({
      candidate,
      job,
      resume,
      organizationId: orgId,
      createdBy: userId,
    });
    return c.json(scoreDto(saved), 200);
  } catch (error) {
    console.error('[ats] scoring failed:', error);
    if (error instanceof Error && error.message === 'RESUME_NOT_PARSED') {
      return c.json({ error: 'Resume has not been parsed successfully' }, 409);
    }
    if (error instanceof AtsPythonError) {
      const status = error.code === 'ats_unreachable' ? 503 : 502;
      return c.json({ error: error.message, code: error.code }, status);
    }
    return c.json({ error: 'Failed to score candidate for job' }, 500);
  }
});

// Advanced Search source: GET /ats/scores?jobId=1&minScore=60&q=alex&limit=50&offset=0
atsRouter.get('/scores', requireAuth, requireRecruiter, async (c) => {
  try {
    const jobId = Number(c.req.query('jobId'));
    if (!Number.isInteger(jobId) || jobId <= 0) return c.json({ error: 'jobId is required' }, 400);
    const minScore = Math.min(100, Math.max(0, Number(c.req.query('minScore') ?? 0) || 0));
    const limit = Math.min(500, Math.max(
      1,
      Number(c.req.query('limit') ?? c.req.query('pageSize') ?? 50) || 50,
    ));
    const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0);
    const q = c.req.query('q')?.trim();
    const userId = c.get('userId');
    const orgId = c.get('organizationId');
    const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
    if (!job || !(await canAccessJob(job, userId, orgId, c.get('userRole')))) {
      return c.json({ error: 'Job not found' }, 404);
    }

    // Keep Advanced Search complete and fresh: score every accessible candidate
    // with a parsed resume. Hashes make repeated calculations deterministic and
    // the upsert replaces stale values after a resume or JD change.
    if (orgId != null) {
      const accessibleCandidates = await db
        .select({ candidate: candidates })
        .from(candidates)
        .innerJoin(users, eq(candidates.createdBy, users.id))
        .where(eq(users.organizationId, orgId))
        .limit(500);
      for (const { candidate } of accessibleCandidates) {
        const [resume] = await db
          .select()
          .from(candidateResumes)
          .where(and(
            eq(candidateResumes.candidateId, candidate.id),
            eq(candidateResumes.parseStatus, 'parsed'),
          ))
          .orderBy(desc(candidateResumes.createdAt), desc(candidateResumes.id))
          .limit(1);
        if (resume) {
          await persistCandidateJobScore({
            candidate,
            job,
            resume,
            organizationId: orgId,
            createdBy: userId,
          });
        }
      }
    }

    const conditions = [eq(candidateJobScores.jobId, jobId), gte(candidateJobScores.totalScore, minScore)];
    if (q) {
      const pattern = `%${q}%`;
      conditions.push(or(ilike(candidates.name, pattern), ilike(candidates.email, pattern))!);
    }
    const rows = await db.select({
      score: candidateJobScores,
      candidateName: candidates.name,
      candidateEmail: candidates.email,
      candidateStatus: candidates.status,
      candidatePhone: candidates.phone,
      candidateLocation: candidates.location,
      candidateExperience: candidates.experience,
      candidateSkills: candidates.skills,
      candidateSummary: candidates.summary,
    }).from(candidateJobScores)
      .innerJoin(candidates, eq(candidateJobScores.candidateId, candidates.id))
      .where(and(...conditions))
      .orderBy(desc(candidateJobScores.totalScore), desc(candidateJobScores.updatedAt))
      .limit(limit)
      .offset(offset);

    const visible = [];
    for (const row of rows) {
      if (await canAccessByCreator(orgId, userId, row.score.createdBy)) {
        visible.push(scoreDto(row.score, {
          candidate: {
            id: row.score.candidateId,
            name: row.candidateName,
            email: row.candidateEmail,
            status: row.candidateStatus,
            phone: row.candidatePhone,
            location: row.candidateLocation,
            experience: row.candidateExperience,
            skills: parseJson(row.candidateSkills ?? '[]', []),
            summary: row.candidateSummary,
          },
        }));
      }
    }
    return c.json({ data: visible, pagination: { limit, offset, returned: visible.length } });
  } catch (error) {
    console.error('[ats] score search failed:', error);
    return c.json({ error: 'Failed to search ATS scores' }, 500);
  }
});

atsRouter.get('/scores/:candidateId/:jobId', requireAuth, requireRecruiter, async (c) => {
  const candidateId = Number(c.req.param('candidateId'));
  const jobId = Number(c.req.param('jobId'));
  if (![candidateId, jobId].every((id) => Number.isInteger(id) && id > 0)) {
    return c.json({ error: 'Invalid candidate or job id' }, 400);
  }
  const [row] = await db.select().from(candidateJobScores).where(and(
    eq(candidateJobScores.candidateId, candidateId),
    eq(candidateJobScores.jobId, jobId),
  )).limit(1);
  if (!row || !(await canAccessByCreator(c.get('organizationId'), c.get('userId'), row.createdBy))) {
    return c.json({ error: 'ATS score not found' }, 404);
  }
  return c.json(scoreDto(row));
});

export default atsRouter;
