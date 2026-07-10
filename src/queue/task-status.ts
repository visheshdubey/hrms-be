import { randomUUID } from 'node:crypto';
import { QUEUE_CONFIG } from './config.js';
import { getRedisClient } from './redis.js';
import type { BatchJobKind, BatchJobStatus } from './types.js';

function batchKey(batchId: string): string {
  return `${QUEUE_CONFIG.batchKeyPrefix}${batchId}`;
}

export function createBatchId(): string {
  return randomUUID();
}

type CreateBatchInput = {
  kind: BatchJobKind;
  total: number;
  campaignId?: number;
  label?: string;
  organizationId?: number | null;
  createdBy?: number;
};

function hashToBatch(id: string, fields: Record<string, string>): BatchJobStatus {
  const batch: BatchJobStatus = {
    id,
    kind: fields.kind as BatchJobKind,
    status: (fields.status ?? 'queued') as BatchJobStatus['status'],
    total: Number(fields.total ?? 0),
    pending: Number(fields.pending ?? 0),
    succeeded: Number(fields.succeeded ?? 0),
    failed: Number(fields.failed ?? 0),
    createdAt: fields.createdAt ?? new Date().toISOString(),
    updatedAt: fields.updatedAt ?? new Date().toISOString(),
    campaignId: fields.campaignId ? Number(fields.campaignId) : undefined,
    label: fields.label || undefined,
    organizationId: fields.organizationId ? Number(fields.organizationId) : null,
    createdBy: fields.createdBy ? Number(fields.createdBy) : undefined,
  };

  if (fields.resultJson) {
    try {
      batch.result = JSON.parse(fields.resultJson) as BatchJobStatus['result'];
    } catch {
      // Ignore corrupt result payloads.
    }
  }

  return batch;
}

function deriveStatus(pending: number, succeeded: number, failed: number): BatchJobStatus['status'] {
  if (pending > 0) return 'processing';
  if (failed > 0 && succeeded > 0) return 'partial';
  if (failed > 0) return 'failed';
  return 'completed';
}

async function refreshBatchStatus(key: string): Promise<void> {
  const redis = getRedisClient();
  const fields = await redis.hgetall(key);
  if (!fields.id) return;

  const pending = Math.max(0, Number(fields.pending ?? 0));
  const succeeded = Number(fields.succeeded ?? 0);
  const failed = Number(fields.failed ?? 0);
  const status = deriveStatus(pending, succeeded, failed);
  const now = new Date().toISOString();

  await redis.hset(key, {
    pending: String(pending),
    status,
    updatedAt: now,
  });
}

export async function createBatchJob(input: CreateBatchInput): Promise<BatchJobStatus> {
  const redis = getRedisClient();
  const now = new Date().toISOString();
  const id = createBatchId();
  const key = batchKey(id);

  const fields: Record<string, string> = {
    id,
    kind: input.kind,
    status: 'queued',
    total: String(input.total),
    pending: String(input.total),
    succeeded: '0',
    failed: '0',
    createdAt: now,
    updatedAt: now,
  };

  if (input.campaignId != null) fields.campaignId = String(input.campaignId);
  if (input.label) fields.label = input.label;
  if (input.organizationId != null) fields.organizationId = String(input.organizationId);
  if (input.createdBy != null) fields.createdBy = String(input.createdBy);

  await redis.hset(key, fields);
  await redis.expire(key, QUEUE_CONFIG.batchTtlSeconds);

  return hashToBatch(id, fields);
}

export async function getBatchJob(batchId: string): Promise<BatchJobStatus | null> {
  const redis = getRedisClient();
  const fields = await redis.hgetall(batchKey(batchId));
  if (!fields.id) return null;
  return hashToBatch(batchId, fields);
}

/** Atomic decrement/increment — safe when multiple workers run. */
async function recordBatchDelta(
  batchId: string,
  delta: { pending: number; succeeded?: number; failed?: number },
): Promise<BatchJobStatus | null> {
  const redis = getRedisClient();
  const key = batchKey(batchId);

  const exists = await redis.exists(key);
  if (!exists) return null;

  const multi = redis.multi();
  multi.hincrby(key, 'pending', delta.pending);
  if (delta.succeeded) multi.hincrby(key, 'succeeded', delta.succeeded);
  if (delta.failed) multi.hincrby(key, 'failed', delta.failed);
  await multi.exec();

  await refreshBatchStatus(key);
  return getBatchJob(batchId);
}

export async function recordBatchTaskSuccess(batchId: string): Promise<BatchJobStatus | null> {
  return recordBatchDelta(batchId, { pending: -1, succeeded: 1 });
}

export async function recordBatchTaskFailure(batchId: string): Promise<BatchJobStatus | null> {
  return recordBatchDelta(batchId, { pending: -1, failed: 1 });
}

export async function setBatchImportResult(
  batchId: string,
  result: { created: number; skipped: number; total: number },
): Promise<void> {
  const redis = getRedisClient();
  const key = batchKey(batchId);
  const exists = await redis.exists(key);
  if (!exists) return;

  await redis.hset(key, {
    resultJson: JSON.stringify(result),
    updatedAt: new Date().toISOString(),
  });
}
