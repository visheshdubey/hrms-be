import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  runCandidateBulkImport,
  type BulkCandidateInputRow,
  type BulkImportResult,
} from '../lib/candidateBulkImport.js';
import { connectRedis } from './redis.js';
import { createBatchJob, recordBatchTaskFailure, recordBatchTaskSuccess, setBatchImportResult } from './task-status.js';
import { enqueueUploadTask } from './upload-queue.js';
import { QUEUE_CONFIG } from './config.js';

const IMPORT_DIR = path.join(process.cwd(), 'uploads', 'imports');

export type StagedBulkImportPayload = {
  rows: BulkCandidateInputRow[];
  userId: number;
  organizationId: number | null;
  sourceFileName?: string;
};

export async function stageBulkImportPayload(payload: StagedBulkImportPayload): Promise<{
  importId: string;
  filePath: string;
  byteSize: number;
}> {
  await mkdir(IMPORT_DIR, { recursive: true });
  const importId = randomUUID();
  const filePath = path.join(IMPORT_DIR, `${importId}.json`);
  const body = JSON.stringify(payload);
  await writeFile(filePath, body, 'utf8');
  return { importId, filePath, byteSize: Buffer.byteLength(body, 'utf8') };
}

export async function readStagedBulkImport(filePath: string): Promise<StagedBulkImportPayload> {
  const raw = await readFile(filePath, 'utf8');
  return JSON.parse(raw) as StagedBulkImportPayload;
}

export async function removeStagedBulkImport(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // Best-effort cleanup after processing.
  }
}

export async function queueCandidateBulkImport(input: {
  rows: BulkCandidateInputRow[];
  userId: number;
  organizationId: number | null;
  sourceFileName?: string;
}): Promise<{
  queued: boolean;
  batchId: string;
  taskId: string;
  inline?: boolean;
  result?: BulkImportResult;
}> {
  const connected = await connectRedis();

  if (!connected) {
    if (!QUEUE_CONFIG.fallbackToInlineBulkImport) {
      throw new Error('Redis unavailable and inline bulk import fallback is disabled');
    }

    const result = await runCandidateBulkImport({
      rows: input.rows,
      userId: input.userId,
      organizationId: input.organizationId,
    });

    return { queued: false, batchId: '', taskId: '', inline: true, result };
  }

  const { filePath, byteSize } = await stageBulkImportPayload({
    rows: input.rows,
    userId: input.userId,
    organizationId: input.organizationId,
    sourceFileName: input.sourceFileName,
  });

  const batch = await createBatchJob({
    kind: 'upload_batch',
    total: 1,
    label: `Bulk candidate import (${input.rows.length} rows)`,
    organizationId: input.organizationId,
    createdBy: input.userId,
  });

  const { taskId, queued } = await enqueueUploadTask({
    type: 'bulk_import',
    userId: input.userId,
    organizationId: input.organizationId,
    fileName: path.basename(filePath),
    filePath,
    byteSize,
    batchId: batch.id,
    metadata: {
      rowCount: input.rows.length,
      sourceFileName: input.sourceFileName,
    },
  });

  if (!queued) {
    await removeStagedBulkImport(filePath);
    if (!QUEUE_CONFIG.fallbackToInlineBulkImport) {
      throw new Error('Failed to enqueue bulk import task');
    }

    const result = await runCandidateBulkImport({
      rows: input.rows,
      userId: input.userId,
      organizationId: input.organizationId,
    });

    return { queued: false, batchId: '', taskId, inline: true, result };
  }

  return { queued: true, batchId: batch.id, taskId };
}

export async function processBulkImportTask(filePath: string, batchId?: string): Promise<BulkImportResult> {
  const payload = await readStagedBulkImport(filePath);

  try {
    const result = await runCandidateBulkImport({
      rows: payload.rows,
      userId: payload.userId,
      organizationId: payload.organizationId,
    });

    if (batchId) {
      await setBatchImportResult(batchId, result);
      await recordBatchTaskSuccess(batchId);
    }

    return result;
  } catch (error) {
    if (batchId) {
      await recordBatchTaskFailure(batchId);
    }
    throw error;
  } finally {
    await removeStagedBulkImport(filePath);
  }
}

export function shouldQueueBulkImport(rowCount: number): boolean {
  return rowCount >= QUEUE_CONFIG.bulkImportQueueThreshold;
}
