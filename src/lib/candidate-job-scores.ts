import { db } from '../db/index.js';
import {
  candidateJobScores,
  candidateResumes,
  candidates,
  jobs,
} from '../db/schema.js';
import {
  AtsPythonError,
  candidateRecordForPythonScore,
  scoreCandidateWithPython,
} from './ats-python-client.js';
import { scoreCandidateForJob } from './ats-scoring.js';

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

  const useLocalFallback = process.env.ATS_LOCAL_FALLBACK === '1' || process.env.ATS_LOCAL_FALLBACK === 'true';
  let result: {
    totalScore: number;
    algorithmVersion: string;
    components: Record<string, unknown>;
    matchedRequirements: string[];
    missingRequirements: string[];
    warnings: string[];
    resumeHash: string;
    jobHash: string;
  };

  try {
    result = await scoreCandidateWithPython({
      candidate: candidateRecordForPythonScore(params.candidate),
      jobDescription: params.job.description ?? '',
      expectedSkills: skillsFromJob(params.job),
      jobId: params.job.id,
      resumeHash: params.resume.contentHash,
    });
  } catch (error) {
    if (!useLocalFallback || !(error instanceof AtsPythonError)) throw error;
    console.warn('[ats] Python score unavailable; ATS_LOCAL_FALLBACK in use:', error.message);
    result = scoreCandidateForJob({
      jobTitle: params.job.title,
      jobDescription: params.job.description ?? '',
      resumeText: params.resume.extractedText,
      resumeHash: params.resume.contentHash,
      candidate: params.candidate,
    });
  }

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
