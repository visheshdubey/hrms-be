import { randomUUID } from 'node:crypto';
import { QUEUE_CONFIG } from './config.js';
import { processBulkImportTask } from './bulk-import.js';
import { connectRedis, getRedisClient } from './redis.js';
import { createBatchJob } from './task-status.js';
import type { UploadTask, UploadTaskType } from './types.js';

export type EnqueueUploadInput = {
  type: UploadTaskType;
  userId: number;
  organizationId?: number | null;
  fileName: string;
  filePath: string;
  byteSize: number;
  metadata?: Record<string, unknown>;
  batchId?: string;
};

export async function enqueueUploadTask(input: EnqueueUploadInput): Promise<{ queued: boolean; taskId: string }> {
  const connected = await connectRedis();
  const task: UploadTask = {
    id: randomUUID(),
    batchId: input.batchId,
    type: input.type,
    userId: input.userId,
    organizationId: input.organizationId ?? null,
    fileName: input.fileName,
    filePath: input.filePath,
    byteSize: input.byteSize,
    metadata: input.metadata,
    attempt: 0,
    maxAttempts: 2,
    createdAt: new Date().toISOString(),
  };

  if (!connected) {
    console.warn('[upload-queue] Redis unavailable — upload task not queued:', task.id);
    return { queued: false, taskId: task.id };
  }

  const redis = getRedisClient();
  await redis.rpush(QUEUE_CONFIG.uploadQueueKey, JSON.stringify(task));
  return { queued: true, taskId: task.id };
}

export async function createUploadBatch(label: string, total: number) {
  return createBatchJob({ kind: 'upload_batch', total, label });
}

async function pushCorruptUploadPayload(payload: string): Promise<void> {
  const redis = getRedisClient();
  await redis.rpush(
    `${QUEUE_CONFIG.uploadQueueKey}:dead`,
    JSON.stringify({
      corrupt: true,
      payload,
      deadLetterReason: 'Invalid JSON payload',
      deadLetterAt: new Date().toISOString(),
    }),
  );
}

export async function popUploadTask(timeoutSeconds = QUEUE_CONFIG.workerPollSeconds): Promise<UploadTask | null> {
  const redis = getRedisClient();
  const result = await redis.blpop(QUEUE_CONFIG.uploadQueueKey, timeoutSeconds);
  if (!result) return null;

  const [, payload] = result;
  try {
    return JSON.parse(payload) as UploadTask;
  } catch {
    console.error('[upload-queue] corrupt task payload moved to dead-letter');
    await pushCorruptUploadPayload(payload);
    return null;
  }
}

export async function processUploadTask(task: UploadTask): Promise<boolean> {
  if (task.type === 'bulk_import') {
    try {
      await processBulkImportTask(task.filePath, task.batchId);
      console.log(
        `[upload-worker] bulk import complete task=${task.id} file=${task.fileName}`,
      );
      return true;
    } catch (error) {
      console.error(`[upload-worker] bulk import failed task=${task.id}:`, error);
      return false;
    }
  }

  console.log(
    `[upload-worker] processed task=${task.id} type=${task.type} file=${task.fileName} bytes=${task.byteSize}`,
  );
  return true;
}

export async function getUploadQueueDepth(): Promise<number> {
  const redis = getRedisClient();
  return redis.llen(QUEUE_CONFIG.uploadQueueKey);
}
