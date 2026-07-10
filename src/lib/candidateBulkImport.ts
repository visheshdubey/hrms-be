import { db } from '../db/index.js';
import { candidates, users } from '../db/schema.js';
import { eq, inArray } from 'drizzle-orm';
import { getOrgMemberIds } from './orgScope.js';

export type BulkCandidateInputRow = {
  name: string;
  email?: string;
  phone?: string;
  location?: string;
  education?: string;
  experience?: string;
  skills?: string[];
  source?: string;
  status?: string;
  linkedin?: string;
  github?: string;
  portfolio?: string;
  summary?: string;
  university?: string;
  grad_year?: string;
};

export type BulkImportResult = {
  created: number;
  skipped: number;
  total: number;
};

export function sanitizeBulkCandidateRows(rows: BulkCandidateInputRow[]) {
  return rows
    .map((row) => ({
      ...row,
      name: row.name.trim(),
      email: (row.email ?? '').trim(),
    }))
    .filter((row) => row.name.length > 0);
}

async function getExistingEmailSet(userId: number, orgId: number | null): Promise<Set<string>> {
  const memberIds = await getOrgMemberIds(orgId, userId);
  if (memberIds.length === 0) return new Set();

  const existing = await db
    .select({ email: candidates.email })
    .from(candidates)
    .where(inArray(candidates.createdBy, memberIds));

  return new Set(
    existing
      .map((row) => (row.email || '').toLowerCase())
      .filter(Boolean),
  );
}

export async function runCandidateBulkImport(input: {
  rows: BulkCandidateInputRow[];
  userId: number;
  organizationId?: number | null;
}): Promise<BulkImportResult> {
  const sanitized = sanitizeBulkCandidateRows(input.rows);
  if (sanitized.length === 0) {
    return { created: 0, skipped: 0, total: 0 };
  }

  const existingEmailSet = await getExistingEmailSet(input.userId, input.organizationId ?? null);
  const toInsert = sanitized.filter(
    (row) => !(row.email && existingEmailSet.has(row.email.toLowerCase())),
  );
  const skipped = sanitized.length - toInsert.length;

  if (toInsert.length === 0) {
    return { created: 0, skipped, total: sanitized.length };
  }

  const values = toInsert.map((row) => ({
    jobId: null,
    filename: 'bulk-upload.csv',
    name: row.name,
    email: row.email || '',
    phone: row.phone || '',
    location: row.location || '',
    education: row.education || '',
    experience: row.experience || '',
    skills: JSON.stringify(Array.isArray(row.skills) ? row.skills : []),
    matchScore: 0,
    status: row.status || 'New',
    source: row.source || 'Bulk Upload',
    linkedin: row.linkedin || '',
    github: row.github || '',
    portfolio: row.portfolio || '',
    certifications: JSON.stringify([]),
    languages: JSON.stringify([]),
    summary: row.summary || '',
    university: row.university || '',
    gradYear: row.grad_year || '',
    workHistory: JSON.stringify([]),
    fingerprint: '',
    createdBy: input.userId,
  }));

  const CHUNK = 100;
  for (let i = 0; i < values.length; i += CHUNK) {
    await db.insert(candidates).values(values.slice(i, i + CHUNK) as typeof values);
  }

  return {
    created: toInsert.length,
    skipped,
    total: sanitized.length,
  };
}
