import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { applicationStageHistory } from '../db/schema.js';

let columnsReady = false;

/** Ensure from_stage_id / to_stage_id exist (safe on older prod DBs). */
export async function ensureApplicationHistoryStageColumns(): Promise<void> {
  if (columnsReady) return;
  try {
    await db.execute(sql`
      ALTER TABLE application_stage_history
        ADD COLUMN IF NOT EXISTS from_stage_id integer
    `);
    await db.execute(sql`
      ALTER TABLE application_stage_history
        ADD COLUMN IF NOT EXISTS to_stage_id integer
    `);
    columnsReady = true;
  } catch {
    // Non-fatal: stats/mindmap fall back to headcounts.
  }
}

export type StageHistoryInsert = {
  applicationId: number;
  fromStatus: string | null;
  toStatus: string;
  fromStageId?: number | null;
  toStageId?: number | null;
  note?: string;
  changedBy?: number | null;
};

export async function insertApplicationStageHistory(row: StageHistoryInsert): Promise<void> {
  await ensureApplicationHistoryStageColumns();
  try {
    await db.insert(applicationStageHistory).values({
      applicationId: row.applicationId,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus as typeof applicationStageHistory.$inferInsert.toStatus,
      fromStageId: row.fromStageId ?? null,
      toStageId: row.toStageId ?? null,
      note: row.note ?? '',
      changedBy: row.changedBy ?? null,
    });
  } catch {
    // Fallback if columns still missing
    await db.insert(applicationStageHistory).values({
      applicationId: row.applicationId,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus as typeof applicationStageHistory.$inferInsert.toStatus,
      note: row.note ?? '',
      changedBy: row.changedBy ?? null,
    });
  }
}
