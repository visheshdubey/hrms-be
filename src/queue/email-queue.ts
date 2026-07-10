import { randomUUID } from 'node:crypto';
import { QUEUE_CONFIG } from './config.js';
import { connectRedis, getRedisClient } from './redis.js';
import { createBatchJob, recordBatchTaskFailure, recordBatchTaskSuccess } from './task-status.js';
import type { EmailTask, EnqueueEmailInput, EnqueueResult } from './types.js';
import { deliverRawEmail } from '../utils/email.js';

const PIPELINE_CHUNK = 500;

function buildEmailTask(input: EnqueueEmailInput): EmailTask {
  return {
    id: randomUUID(),
    batchId: input.batchId,
    type: input.type,
    to: input.to,
    subject: input.subject,
    html: input.html,
    metadata: input.metadata,
    attempt: 0,
    maxAttempts: input.maxAttempts ?? QUEUE_CONFIG.maxEmailAttempts,
    createdAt: new Date().toISOString(),
  };
}

async function pushTasksToRedis(tasks: EmailTask[]): Promise<void> {
  const redis = getRedisClient();

  for (let i = 0; i < tasks.length; i += PIPELINE_CHUNK) {
    const chunk = tasks.slice(i, i + PIPELINE_CHUNK);
    const pipeline = redis.pipeline();
    for (const task of chunk) {
      pipeline.rpush(QUEUE_CONFIG.emailQueueKey, JSON.stringify(task));
    }
    await pipeline.exec();
  }
}

export async function enqueueEmailTask(input: EnqueueEmailInput): Promise<EnqueueResult> {
  const connected = await connectRedis();
  const task = buildEmailTask(input);

  if (!connected) {
    if (!QUEUE_CONFIG.fallbackToInlineEmail) {
      throw new Error('Redis unavailable and inline email fallback is disabled');
    }

    const sent = await deliverRawEmail({
      to: task.to,
      subject: task.subject,
      html: task.html,
      label: `Inline ${task.type}`,
    });

    if (task.batchId) {
      if (sent) await recordBatchTaskSuccess(task.batchId);
      else await recordBatchTaskFailure(task.batchId);
    }

    return { queued: false, taskId: task.id, batchId: task.batchId, inline: true };
  }

  await pushTasksToRedis([task]);
  return { queued: true, taskId: task.id, batchId: task.batchId };
}

type BatchOptions = {
  campaignId?: number;
  label?: string;
  organizationId?: number | null;
  createdBy?: number;
};

export async function enqueueEmailBatch(
  items: EnqueueEmailInput[],
  options: BatchOptions = {},
): Promise<{ batchId: string; queued: number; inline: number }> {
  if (items.length === 0) {
    throw new Error('At least one email is required');
  }

  const connected = await connectRedis();

  if (!connected) {
    if (!QUEUE_CONFIG.fallbackToInlineEmail) {
      throw new Error('Redis unavailable and inline email fallback is disabled');
    }

    let inline = 0;
    for (const item of items) {
      const result = await enqueueEmailTask(item);
      if (result.inline) inline += 1;
    }

    return { batchId: '', queued: 0, inline };
  }

  const batch = await createBatchJob({
    kind: 'email_batch',
    total: items.length,
    campaignId: options.campaignId,
    label: options.label,
    organizationId: options.organizationId,
    createdBy: options.createdBy,
  });

  const tasks = items.map((item) => buildEmailTask({ ...item, batchId: batch.id }));
  await pushTasksToRedis(tasks);

  return { batchId: batch.id, queued: tasks.length, inline: 0 };
}

async function pushCorruptPayload(payload: string): Promise<void> {
  const redis = getRedisClient();
  await redis.rpush(
    QUEUE_CONFIG.emailDeadLetterKey,
    JSON.stringify({
      corrupt: true,
      payload,
      deadLetterReason: 'Invalid JSON payload',
      deadLetterAt: new Date().toISOString(),
    }),
  );
}

export async function popEmailTask(timeoutSeconds = QUEUE_CONFIG.workerPollSeconds): Promise<EmailTask | null> {
  const redis = getRedisClient();
  const result = await redis.blpop(QUEUE_CONFIG.emailQueueKey, timeoutSeconds);
  if (!result) return null;

  const [, payload] = result;
  try {
    return JSON.parse(payload) as EmailTask;
  } catch {
    console.error('[email-queue] corrupt task payload moved to dead-letter');
    await pushCorruptPayload(payload);
    return null;
  }
}

async function pushDeadLetter(task: EmailTask, reason: string): Promise<void> {
  const redis = getRedisClient();
  await redis.rpush(
    QUEUE_CONFIG.emailDeadLetterKey,
    JSON.stringify({ ...task, deadLetterReason: reason, deadLetterAt: new Date().toISOString() }),
  );
}

export async function processEmailTask(task: EmailTask): Promise<boolean> {
  const attempt = task.attempt + 1;
  const currentTask: EmailTask = { ...task, attempt };

  const sent = await deliverRawEmail({
    to: currentTask.to,
    subject: currentTask.subject,
    html: currentTask.html,
    label: `Queued ${currentTask.type}`,
  });

  if (sent) {
    if (currentTask.batchId) {
      await recordBatchTaskSuccess(currentTask.batchId);
    }
    return true;
  }

  if (attempt >= currentTask.maxAttempts) {
    await pushDeadLetter(currentTask, 'Max attempts reached');
    if (currentTask.batchId) {
      await recordBatchTaskFailure(currentTask.batchId);
    }
    return false;
  }

  const retryTask: EmailTask = {
    ...currentTask,
    attempt,
    createdAt: new Date().toISOString(),
  };

  await pushTasksToRedis([retryTask]);
  return false;
}

export async function getEmailQueueDepth(): Promise<{ pending: number; deadLetter: number }> {
  const redis = getRedisClient();
  const [pendingCount, deadCount] = await Promise.all([
    redis.llen(QUEUE_CONFIG.emailQueueKey),
    redis.llen(QUEUE_CONFIG.emailDeadLetterKey),
  ]);
  return { pending: pendingCount, deadLetter: deadCount };
}
