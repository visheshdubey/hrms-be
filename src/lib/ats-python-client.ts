import { createHash } from 'node:crypto';
import type { ExtractedResumeData, ResumeWorkHistoryEntry } from './resume-extraction.js';

const DEFAULT_ATS_URL = 'http://127.0.0.1:8000';
const PARSE_TIMEOUT_MS = 120_000;
const SCORE_TIMEOUT_MS = 30_000;

export class AtsPythonError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'AtsPythonError';
  }
}

export type AtsParseResult = {
  text: string;
  data: ExtractedResumeData;
  matchScore: number | null;
  algorithmVersion: string;
};

export type AtsScoreResult = {
  totalScore: number;
  algorithmVersion: string;
  components: Record<string, unknown>;
  matchedRequirements: string[];
  missingRequirements: string[];
  warnings: string[];
  resumeHash: string;
  jobHash: string;
};

function atsBaseUrl(): string {
  return (process.env.ATS_API_URL ?? DEFAULT_ATS_URL).replace(/\/$/, '');
}

function atsHeaders(json = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (json) headers['Content-Type'] = 'application/json';
  const key = process.env.ATS_API_KEY?.trim();
  if (key) headers['X-ATS-API-Key'] = key;
  return headers;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asString(item)).filter(Boolean);
}

function asWorkHistory(value: unknown): ResumeWorkHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry) => ({
      title: asString(entry.title),
      company: asString(entry.company),
      duration: asString(entry.duration),
    }));
}

/** Map Python /api/parse `extracted` (or legacy snake_case candidate) → ExtractedResumeData. */
export function mapPythonExtracted(raw: unknown, fallbackText = ''): ExtractedResumeData {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const email = asString(src.email);
  const phone = asString(src.phone);
  const emails = asStringArray(src.emails);
  const phones = asStringArray(src.phones);
  if (email && !emails.includes(email)) emails.unshift(email);
  if (phone && !phones.includes(phone)) phones.unshift(phone);

  const skills = asStringArray(src.skills);
  const missingFields = asStringArray(src.missingFields ?? src.missing_fields);
  const warnings = asStringArray(src.warnings);
  const textLength = Number(src.textLength ?? src.text_length ?? fallbackText.length) || fallbackText.length;
  const profileScore = Number(src.profileScore ?? src.profile_score ?? src.match_score ?? 0) || 0;

  return {
    name: asString(src.name),
    email,
    emails,
    phone,
    phones,
    location: asString(src.location),
    education: asString(src.education),
    experience: asString(src.experience),
    skills,
    linkedin: asString(src.linkedin),
    github: asString(src.github),
    portfolio: asString(src.portfolio),
    summary: asString(src.summary),
    university: asString(src.university),
    gradYear: asString(src.gradYear ?? src.grad_year),
    certifications: asStringArray(src.certifications),
    languages: asStringArray(src.languages),
    workHistory: asWorkHistory(src.workHistory ?? src.work_history),
    links: asStringArray(src.links),
    fingerprint: asString(src.fingerprint),
    missingFields,
    warnings,
    ocrRecommended: Boolean(src.ocrRecommended ?? src.ocr_recommended),
    profileScore,
    textLength,
  };
}

export function candidateRecordForPythonScore(candidate: {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  location?: string | null;
  education?: string | null;
  experience?: string | null;
  skills?: string | null;
  certifications?: string | null;
  languages?: string | null;
  summary?: string | null;
  university?: string | null;
  gradYear?: string | null;
  workHistory?: string | null;
  matchScore?: number | null;
}): Record<string, unknown> {
  const parse = <T>(raw: string | null | undefined, fallback: T): T => {
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  };
  return {
    name: candidate.name ?? '',
    email: candidate.email ?? '',
    phone: candidate.phone ?? '',
    location: candidate.location ?? '',
    education: candidate.education ?? '',
    experience: candidate.experience ?? '',
    skills: parse<string[]>(candidate.skills, []),
    certifications: parse<string[]>(candidate.certifications, []),
    languages: parse<string[]>(candidate.languages, []),
    summary: candidate.summary ?? '',
    university: candidate.university ?? '',
    grad_year: candidate.gradYear ?? '',
    work_history: parse<unknown[]>(candidate.workHistory, []),
    match_score: candidate.matchScore ?? 0,
  };
}

export async function parseResumeWithPython(input: {
  buffer: Buffer;
  filename: string;
  mime: string;
  jobId?: number | string | null;
  jobDescription?: string | null;
  expectedSkills?: string[] | null;
}): Promise<AtsParseResult> {
  const form = new FormData();
  const bytes = new Uint8Array(input.buffer);
  form.append(
    'file',
    new File([bytes], input.filename || 'resume.pdf', { type: input.mime }),
  );
  if (input.jobId != null && String(input.jobId).trim()) {
    form.append('job_id', String(input.jobId));
  }
  if (input.jobDescription?.trim()) {
    form.append('job_description', input.jobDescription);
  }
  if (input.expectedSkills?.length) {
    form.append('expected_skills', JSON.stringify(input.expectedSkills));
  }

  let response: Response;
  try {
    response = await fetch(`${atsBaseUrl()}/api/parse`, {
      method: 'POST',
      headers: atsHeaders(false),
      body: form,
      signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AtsPythonError(
      `ATS service unreachable at ${atsBaseUrl()} (${error instanceof Error ? error.message : String(error)})`,
      'ats_unreachable',
      503,
    );
  }

  const textBody = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = textBody ? JSON.parse(textBody) as Record<string, unknown> : {};
  } catch {
    json = {};
  }

  if (!response.ok || json.success === false) {
    const message = asString(json.error) || textBody.slice(0, 240) || `ATS parse failed (${response.status})`;
    throw new AtsPythonError(message, 'ats_parse_failed', response.status);
  }

  const rawText = asString(json.raw_text ?? json.rawText);
  const data = mapPythonExtracted(json.extracted ?? json.candidate, rawText);
  const matchScore = json.match_score == null && json.matchScore == null
    ? null
    : Number(json.match_score ?? json.matchScore);
  return {
    text: rawText || data.summary || '',
    data,
    matchScore: Number.isFinite(matchScore) ? matchScore : null,
    algorithmVersion: asString(json.algorithm_version ?? json.algorithmVersion) || 'hrms-py',
  };
}

export async function scoreCandidateWithPython(input: {
  candidate: Record<string, unknown>;
  jobDescription?: string | null;
  expectedSkills?: string[] | null;
  jobId?: number | string | null;
  resumeHash: string;
}): Promise<AtsScoreResult> {
  let response: Response;
  try {
    response = await fetch(`${atsBaseUrl()}/api/score`, {
      method: 'POST',
      headers: atsHeaders(true),
      body: JSON.stringify({
        candidate: input.candidate,
        job_description: input.jobDescription ?? '',
        expected_skills: input.expectedSkills ?? [],
        job_id: input.jobId != null ? String(input.jobId) : undefined,
      }),
      signal: AbortSignal.timeout(SCORE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AtsPythonError(
      `ATS service unreachable at ${atsBaseUrl()} (${error instanceof Error ? error.message : String(error)})`,
      'ats_unreachable',
      503,
    );
  }

  const textBody = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = textBody ? JSON.parse(textBody) as Record<string, unknown> : {};
  } catch {
    json = {};
  }

  if (!response.ok || json.success === false) {
    const message = asString(json.error) || textBody.slice(0, 240) || `ATS score failed (${response.status})`;
    throw new AtsPythonError(message, 'ats_score_failed', response.status);
  }

  const totalScore = Math.min(100, Math.max(0, Number(json.match_score ?? json.matchScore ?? 0) || 0));
  const jobHash = createHash('sha256')
    .update(String(input.jobDescription ?? ''))
    .update('|')
    .update(JSON.stringify(input.expectedSkills ?? []))
    .digest('hex');

  return {
    totalScore,
    algorithmVersion: asString(json.algorithm_version ?? json.algorithmVersion) || 'hrms-py',
    components: (json.components && typeof json.components === 'object'
      ? json.components
      : {}) as Record<string, unknown>,
    matchedRequirements: asStringArray(json.matchedRequirements ?? json.matched_requirements),
    missingRequirements: asStringArray(json.missingRequirements ?? json.missing_requirements),
    warnings: asStringArray(json.warnings),
    resumeHash: input.resumeHash,
    jobHash,
  };
}
