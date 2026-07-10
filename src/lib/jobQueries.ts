import { db } from '../db/index.js';
import { jobs } from '../db/schema.js';
import { eq, desc, type SQL } from 'drizzle-orm';

const LEGACY_JOB_SELECT = {
  id: jobs.id,
  title: jobs.title,
  department: jobs.department,
  status: jobs.status,
  type: jobs.type,
  location: jobs.location,
  applicants: jobs.applicants,
  description: jobs.description,
  postedDate: jobs.postedDate,
  accountId: jobs.accountId,
  payPackageMin: jobs.payPackageMin,
  payPackageMax: jobs.payPackageMax,
  payCurrency: jobs.payCurrency,
  createdBy: jobs.createdBy,
} as const;

const MINIMAL_JOB_SELECT = {
  id: jobs.id,
  title: jobs.title,
  department: jobs.department,
  status: jobs.status,
  type: jobs.type,
  location: jobs.location,
  applicants: jobs.applicants,
  description: jobs.description,
  postedDate: jobs.postedDate,
  accountId: jobs.accountId,
  createdBy: jobs.createdBy,
} as const;

function withJobDefaults<T extends Record<string, unknown>>(row: T) {
  return {
    ...row,
    assignedTo: (row as { assignedTo?: number | null }).assignedTo ?? null,
    payPackageMin: (row as { payPackageMin?: number | null }).payPackageMin ?? null,
    payPackageMax: (row as { payPackageMax?: number | null }).payPackageMax ?? null,
    payCurrency: (row as { payCurrency?: string | null }).payCurrency ?? 'INR',
  };
}

export async function selectJobById(id: number) {
  try {
    return await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
  } catch {
    try {
      const rows = await db.select(LEGACY_JOB_SELECT).from(jobs).where(eq(jobs.id, id)).limit(1);
      return rows.map(withJobDefaults);
    } catch {
      const rows = await db.select(MINIMAL_JOB_SELECT).from(jobs).where(eq(jobs.id, id)).limit(1);
      return rows.map(withJobDefaults);
    }
  }
}

export async function selectJobsWhere(where?: SQL) {
  const run = async (columns?: Record<string, unknown>) => {
    const base = columns ? db.select(columns as any).from(jobs) : db.select().from(jobs);
    return where ? await base.where(where).orderBy(desc(jobs.id)) : await base.orderBy(desc(jobs.id));
  };

  try {
    return await run();
  } catch {
    try {
      const rows = await run(LEGACY_JOB_SELECT);
      return rows.map(withJobDefaults);
    } catch {
      const rows = await run(MINIMAL_JOB_SELECT);
      return rows.map(withJobDefaults);
    }
  }
}
