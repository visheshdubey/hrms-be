export const QUEUE_CONFIG = {
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  emailQueueKey: process.env.EMAIL_QUEUE_KEY ?? 'hrms:queue:email',
  emailDeadLetterKey: process.env.EMAIL_DEAD_LETTER_KEY ?? 'hrms:queue:email:dead',
  uploadQueueKey: process.env.UPLOAD_QUEUE_KEY ?? 'hrms:queue:upload',
  batchKeyPrefix: process.env.BATCH_KEY_PREFIX ?? 'hrms:batch:',
  maxEmailAttempts: Number(process.env.QUEUE_MAX_EMAIL_ATTEMPTS ?? '3'),
  workerPollSeconds: Number(process.env.QUEUE_WORKER_POLL_SECONDS ?? '2'),
  batchTtlSeconds: Number(process.env.QUEUE_BATCH_TTL_SECONDS ?? String(60 * 60 * 24 * 7)),
  enableWorker: process.env.ENABLE_QUEUE_WORKER !== 'false',
  fallbackToInlineEmail: process.env.QUEUE_FALLBACK_INLINE_EMAIL !== 'false',
  fallbackToInlineBulkImport: process.env.QUEUE_FALLBACK_INLINE_BULK_IMPORT !== 'false',
  bulkImportQueueThreshold: Number(process.env.BULK_IMPORT_QUEUE_THRESHOLD ?? '1'),
} as const;
