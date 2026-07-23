import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { candidateResumes, candidates, jobs } from '../db/schema.js';
import { cdn } from '../lib/bunny-cdn.js';
import { createApplicationsAtomically } from '../lib/application-writes.js';
import { persistCandidateJobScore } from '../lib/candidate-job-scores.js';
import { canAccessByCreator, canAccessJob } from '../lib/orgScope.js';
import {
  type ExtractedResumeData,
  ResumeInputError,
  sha256,
  validateResumeFile,
  RESUME_MIMES,
  extractResume,
} from '../lib/resume-extraction.js';
import { AtsPythonError, parseResumeWithPython } from '../lib/ats-python-client.js';
import { requireAuth, requireRecruiter, type AppContext } from '../middleware.js';

const resumesRouter = new Hono<AppContext>({ strict: false });

async function extractViaAtsOrFallback(buffer: Buffer, mime: typeof RESUME_MIMES[keyof typeof RESUME_MIMES], filename: string, job?: {
  id: number;
  title?: string | null;
  description: string | null;
} | null) {
  const useLocalFallback = process.env.ATS_LOCAL_FALLBACK === '1' || process.env.ATS_LOCAL_FALLBACK === 'true';
  const expectedSkills = (() => {
    if (!job) return [] as string[];
    const text = `${job.title ?? ''} ${job.description ?? ''}`.toLowerCase();
    return [...new Set(
      text.split(/[^a-z0-9+#.]+/i).map((p) => p.trim()).filter((p) => p.length >= 2 && p.length <= 24),
    )].slice(0, 30);
  })();

  try {
    return await parseResumeWithPython({
      buffer,
      filename,
      mime,
      jobId: job?.id,
      jobDescription: job?.description,
      expectedSkills,
    });
  } catch (error) {
    if (!useLocalFallback || !(error instanceof AtsPythonError)) throw error;
    console.warn('[resumes] Python parse unavailable; ATS_LOCAL_FALLBACK in use:', error.message);
    const local = await extractResume(buffer, mime);
    return {
      text: local.text,
      data: local.data,
      matchScore: local.data.profileScore,
      algorithmVersion: 'ats-local-fallback',
    };
  }
}

function parseId(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function safeName(value: string): string {
  return value.replace(/[\r\n"]/g, '_').replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 180) || 'resume';
}

function candidateValuesFromResume(data: ExtractedResumeData, filename: string) {
  return {
    filename: safeName(filename),
    name: data.name || path.basename(filename, path.extname(filename)).replace(/[_-]+/g, ' ').trim() || 'Imported candidate',
    email: data.email || '',
    phone: data.phone || '',
    location: data.location || '',
    education: data.education || '',
    experience: data.experience || '',
    skills: JSON.stringify(data.skills),
    matchScore: data.profileScore,
    linkedin: data.linkedin || '',
    github: data.github || '',
    portfolio: data.portfolio || '',
    certifications: JSON.stringify(data.certifications),
    languages: JSON.stringify(data.languages),
    summary: data.summary || '',
    university: data.university || '',
    gradYear: data.gradYear || '',
    workHistory: JSON.stringify(data.workHistory),
    fingerprint: data.fingerprint || '',
    source: 'Resume import',
    status: 'New' as const,
  };
}

async function hydrateCandidateFromResume(
  candidate: typeof candidates.$inferSelect,
  data: ExtractedResumeData,
  filename: string,
) {
  const values = candidateValuesFromResume(data, filename);
  const patch: Record<string, unknown> = {
    filename: values.filename,
    skills: values.skills,
    matchScore: values.matchScore,
    fingerprint: values.fingerprint || candidate.fingerprint,
    certifications: values.certifications,
    languages: values.languages,
    workHistory: values.workHistory,
  };

  const fillIfEmpty = (key: keyof typeof values, current: string | null | undefined) => {
    if ((!current || !String(current).trim()) && values[key]) patch[key] = values[key];
  };

  // Prefer richer parser values on resume import, especially for newly created/broken rows.
  if (data.name) patch.name = data.name;
  if (data.email) patch.email = data.email;
  if (data.phone) patch.phone = data.phone;
  if (data.location) patch.location = data.location;
  if (data.education) patch.education = data.education;
  if (data.experience) patch.experience = data.experience;
  if (data.summary) patch.summary = data.summary;
  if (data.university) patch.university = data.university;
  if (data.gradYear) patch.gradYear = data.gradYear;
  if (data.linkedin) patch.linkedin = data.linkedin;
  if (data.github) patch.github = data.github;
  if (data.portfolio) patch.portfolio = data.portfolio;
  fillIfEmpty('source', candidate.source);

  const [updated] = await db.update(candidates)
    .set(patch as any)
    .where(eq(candidates.id, candidate.id))
    .returning();
  return updated ?? candidate;
}

function dto(row: typeof candidateResumes.$inferSelect, extra: Record<string, unknown> = {}) {
  let extractedData: unknown = {};
  try { extractedData = JSON.parse(row.extractedData || '{}'); } catch { /* keep empty */ }
  return {
    id: row.id,
    candidateId: row.candidateId,
    filename: row.originalFilename,
    originalFilename: row.originalFilename,
    mimeType: row.mimeType,
    byteSize: row.byteSize,
    contentHash: row.contentHash,
    parseStatus: row.parseStatus,
    parseError: row.parseError,
    status: row.parseStatus === 'parsed' ? 'completed' : row.parseStatus === 'pending' ? 'processing' : 'failed',
    error: row.parseError,
    extractedData,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    downloadUrl: `/resumes/${row.id}/download`,
    ...extra,
  };
}

async function getOwnedCandidate(candidateId: number, userId: number, orgId: number | null) {
  const [candidate] = await db.select().from(candidates).where(eq(candidates.id, candidateId)).limit(1);
  if (!candidate || !(await canAccessByCreator(orgId, userId, candidate.createdBy))) return null;
  return candidate;
}

async function storeResume(buffer: Buffer, filename: string): Promise<string> {
  const storagePath = `resumes/${filename}`;
  if (cdn.isConfigured()) {
    return (await cdn.upload('resumes', buffer, filename)).storagePath;
  }
  const directory = path.join(process.cwd(), 'uploads', 'resumes');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, filename), buffer);
  return storagePath;
}

async function loadResume(storagePath: string): Promise<Buffer> {
  if (!/^resumes\/[a-zA-Z0-9._-]+$/.test(storagePath)) throw new Error('Invalid resume storage path');
  if (cdn.isConfigured()) return cdn.download(storagePath);
  return readFile(path.join(process.cwd(), 'uploads', storagePath));
}

async function deleteStoredResume(storagePath: string): Promise<void> {
  if (!/^resumes\/[a-zA-Z0-9._-]+$/.test(storagePath)) throw new Error('Invalid resume storage path');
  if (cdn.isConfigured()) {
    await cdn.remove(storagePath);
    return;
  }
  await unlink(path.join(process.cwd(), 'uploads', storagePath)).catch(() => undefined);
}

// POST /candidate-resumes — multipart fields: file, optional candidateId/jobId.
resumesRouter.post('/', requireAuth, requireRecruiter, async (c) => {
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  try {
    const body = await c.req.parseBody();
    let candidateId = parseId(String(body.candidateId ?? ''));
    const jobId = parseId(String(body.jobId ?? ''));
    const file = body.file;
    if (!(file instanceof File)) return c.json({ error: 'Resume file is required', code: 'missing_file' }, 400);

    const buffer = Buffer.from(await file.arrayBuffer());
    const mime = validateResumeFile(file, buffer);

    // Resolve job early so Python can score against JD during parse.
    let job: typeof jobs.$inferSelect | null = null;
    if (jobId) {
      [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
      if (!job || !(await canAccessJob(job, userId, orgId, c.get('userRole')))) {
        return c.json({ error: 'Job not found', code: 'job_not_found' }, 404);
      }
      if (job.status !== 'submission_in_progress') {
        return c.json({ error: 'Only active jobs can receive applications', code: 'job_not_active' }, 409);
      }
    }

    const extracted = await extractViaAtsOrFallback(buffer, mime, file.name, job);
    let candidate = candidateId ? await getOwnedCandidate(candidateId, userId, orgId) : null;
    if (candidateId && !candidate) {
      return c.json({ error: 'Candidate not found', code: 'candidate_not_found' }, 404);
    }
    if (!candidate) {
      const email = extracted.data.email || extracted.data.emails[0] || '';
      if (email) {
        const matches = await db.select().from(candidates).where(eq(candidates.email, email));
        for (const match of matches) {
          if (await canAccessByCreator(orgId, userId, match.createdBy)) {
            candidate = match;
            break;
          }
        }
      }
      if (!candidate) {
        [candidate] = await db.insert(candidates).values({
          ...candidateValuesFromResume(extracted.data, file.name),
          createdBy: userId,
        }).returning();
      }
      if (!candidate) throw new Error('CANDIDATE_CREATE_FAILED');
      candidateId = candidate.id;
    }

    candidate = await hydrateCandidateFromResume(candidate, extracted.data, file.name);

    const extension = mime === RESUME_MIMES.pdf ? 'pdf' : 'docx';
    const storagePath = await storeResume(buffer, `${randomUUID()}.${extension}`);
    const now = new Date().toISOString();
    const [resume] = await db.insert(candidateResumes).values({
      candidateId: candidate.id,
      organizationId: orgId,
      createdBy: userId,
      originalFilename: safeName(file.name),
      storagePath,
      mimeType: mime,
      byteSize: buffer.length,
      contentHash: sha256(buffer),
      parseStatus: 'parsed',
      extractedText: extracted.text,
      extractedData: JSON.stringify(extracted.data),
      createdAt: now,
      updatedAt: now,
    }).returning();

    let score: Awaited<ReturnType<typeof persistCandidateJobScore>> | null = null;
    if (job) {
      await createApplicationsAtomically({
        jobId: job.id,
        userId,
        assignedTo: userId,
        applications: [{ candidateId: candidate.id, notes: 'Created from resume import' }],
      });
      score = await persistCandidateJobScore({
        candidate,
        job,
        resume,
        organizationId: orgId,
        createdBy: userId,
      });
      if (score) {
        const [scored] = await db.update(candidates)
          .set({ matchScore: score.totalScore })
          .where(eq(candidates.id, candidate.id))
          .returning();
        if (scored) candidate = scored;
      }
    }
    return c.json(dto(resume, {
      candidate: {
        id: candidate.id,
        name: candidate.name,
        email: candidate.email,
        phone: candidate.phone,
        location: candidate.location,
        experience: candidate.experience,
        matchScore: candidate.matchScore,
      },
      jobId: job?.id ?? null,
      jobScore: score ? { candidateId: candidate.id, jobId: job!.id, score: score.totalScore } : null,
      algorithmVersion: extracted.algorithmVersion,
    }), 201);
  } catch (error) {
    if (error instanceof ResumeInputError) {
      return c.json({ error: error.message, code: error.code }, 400);
    }
    if (error instanceof AtsPythonError) {
      const status = error.status === 401 || error.status === 403 ? 502
        : error.code === 'ats_unreachable' ? 503
          : 502;
      return c.json({ error: error.message, code: error.code }, status);
    }
    console.error('[resumes] ingestion failed:', error);
    return c.json({ error: 'Failed to ingest resume', code: 'ingestion_failed' }, 500);
  }
});

// GET /resumes?candidateId=123 — metadata only; never exposes storage paths.
resumesRouter.get('/', requireAuth, requireRecruiter, async (c) => {
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const candidateId = parseId(c.req.query('candidateId') ?? '');
  if (!candidateId) return c.json({ error: 'candidateId query parameter is required' }, 400);
  if (!(await getOwnedCandidate(candidateId, userId, orgId))) return c.json({ error: 'Candidate not found' }, 404);
  const rows = await db.select().from(candidateResumes)
    .where(eq(candidateResumes.candidateId, candidateId))
    .orderBy(desc(candidateResumes.createdAt), desc(candidateResumes.id));
  return c.json({ data: rows.map((row) => dto(row)) });
});

resumesRouter.get('/:id', requireAuth, requireRecruiter, async (c) => {
  const id = parseId(c.req.param('id'));
  if (!id) return c.json({ error: 'Invalid resume id' }, 400);
  const [row] = await db.select().from(candidateResumes).where(eq(candidateResumes.id, id)).limit(1);
  if (!row || !(await canAccessByCreator(c.get('organizationId'), c.get('userId'), row.createdBy))) {
    return c.json({ error: 'Resume not found' }, 404);
  }
  const [candidate] = await db.select({ id: candidates.id, name: candidates.name })
    .from(candidates)
    .where(eq(candidates.id, row.candidateId))
    .limit(1);
  return c.json(dto(row, { candidate: candidate ?? null }));
});

resumesRouter.get('/:id/download', requireAuth, requireRecruiter, async (c) => {
  try {
    const id = parseId(c.req.param('id'));
    if (!id) return c.json({ error: 'Invalid resume id' }, 400);
    const inline = c.req.query('inline') === '1' || c.req.query('inline') === 'true';
    const [row] = await db.select().from(candidateResumes)
      .where(and(eq(candidateResumes.id, id)))
      .limit(1);
    if (!row || !(await canAccessByCreator(c.get('organizationId'), c.get('userId'), row.createdBy))) {
      return c.json({ error: 'Resume not found' }, 404);
    }
    const buffer = await loadResume(row.storagePath);
    const disposition = inline
      ? `inline; filename="${safeName(row.originalFilename)}"`
      : `attachment; filename="${safeName(row.originalFilename)}"`;
    return new Response(new Uint8Array(buffer), {
      headers: {
        'Content-Type': row.mimeType,
        'Content-Length': String(buffer.length),
        'Content-Disposition': disposition,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    console.error('[resumes] download failed:', error);
    return c.json({ error: 'Resume file is unavailable' }, 404);
  }
});

resumesRouter.delete('/:id', requireAuth, requireRecruiter, async (c) => {
  try {
    const id = parseId(c.req.param('id'));
    if (!id) return c.json({ error: 'Invalid resume id' }, 400);
    const [row] = await db.select().from(candidateResumes).where(eq(candidateResumes.id, id)).limit(1);
    if (!row || !(await canAccessByCreator(c.get('organizationId'), c.get('userId'), row.createdBy))) {
      return c.json({ error: 'Resume not found' }, 404);
    }
    await db.delete(candidateResumes).where(eq(candidateResumes.id, id));
    await deleteStoredResume(row.storagePath).catch((error) => {
      console.warn('[resumes] storage cleanup failed:', error);
    });
    return c.json({ ok: true, id: row.id, candidateId: row.candidateId });
  } catch (error) {
    console.error('[resumes] delete failed:', error);
    return c.json({ error: 'Failed to delete resume' }, 500);
  }
});

export default resumesRouter;
