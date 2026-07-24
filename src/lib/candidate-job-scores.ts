import { db } from '../db/index.js';
import {
  candidateJobScores,
  candidateResumes,
  candidates,
  jobs,
} from '../db/schema.js';
import {
  candidateRecordForPythonScore,
  scoreCandidateWithPython,
} from './ats-python-client.js';

function skillsFromJob(job: typeof jobs.$inferSelect): string[] {
  // Jobs table stores free-text description only — extract likely skill tokens.
  const text = `${job.title ?? ''} ${job.description ?? ''}`.toLowerCase();
  const tokens = text
    .split(/[^a-z0-9+#.]+/i)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && part.length <= 24);
  return [...new Set(tokens)].slice(0, 30);
}

export async function persistCandidateJobScore(params: {
  candidate: typeof candidates.$inferSelect;
  job: typeof jobs.$inferSelect;
  resume: typeof candidateResumes.$inferSelect;
  organizationId: number | null;
  createdBy: number;
}) {
  if (params.resume.parseStatus !== 'parsed' || !params.resume.extractedText) {
    throw new Error('RESUME_NOT_PARSED');
  }

  // ATS score is Python-only — no Hono/local fallback.
  const result = await scoreCandidateWithPython({
    candidate: candidateRecordForPythonScore(params.candidate),
    jobDescription: params.job.description ?? '',
    expectedSkills: skillsFromJob(params.job),
    jobId: params.job.id,
    resumeHash: params.resume.contentHash,
  });

  const now = new Date().toISOString();
  const values = {
    candidateId: params.candidate.id,
    resumeId: params.resume.id,
    jobId: params.job.id,
    organizationId: params.organizationId,
    createdBy: params.createdBy,
    resumeHash: result.resumeHash,
    jobHash: result.jobHash,
    algorithmVersion: result.algorithmVersion,
    totalScore: result.totalScore,
    components: JSON.stringify(result.components),
    matchedRequirements: JSON.stringify(result.matchedRequirements),
    missingRequirements: JSON.stringify(result.missingRequirements),
    warnings: JSON.stringify(result.warnings),
    updatedAt: now,
  };

  const [saved] = await db
    .insert(candidateJobScores)
    .values({ ...values, createdAt: now })
    .onConflictDoUpdate({
      target: [candidateJobScores.candidateId, candidateJobScores.jobId],
      set: values,
    })
    .returning();

  return saved;
}
