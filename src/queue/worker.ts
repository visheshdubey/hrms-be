import { QUEUE_CONFIG } from './config.js';
import { popEmailTask, processEmailTask } from './email-queue.js';
import { connectRedis } from './redis.js';
import { popUploadTask, processUploadTask } from './upload-queue.js';

let workerRunning = false;
let workerTimer: NodeJS.Timeout | null = null;
let workerStartAttempted = false;

async function workerTick(): Promise<void> {
  if (!workerRunning) return;

  const emailTask = await popEmailTask(1);
  if (emailTask) {
    await processEmailTask(emailTask);
    return;
  }

  const uploadTask = await popUploadTask(1);
  if (uploadTask) {
    await processUploadTask(uploadTask);
  }
}

export async function startQueueWorker(): Promise<void> {
  if (workerRunning) return;

  const connected = await connectRedis();
  if (!connected) {
    if (!workerStartAttempted) {
      workerStartAttempted = true;
      console.warn('[queue-worker] Redis not available — will retry. Emails use inline fallback when enabled.');
    }
    workerTimer = setTimeout(() => {
      void startQueueWorker();
    }, 5000);
    return;
  }

  workerRunning = true;
  console.log('[queue-worker] started (in-process, pop-one-by-one)');

  const loop = async () => {
    if (!workerRunning) return;
    try {
      await workerTick();
    } catch (error) {
      console.error('[queue-worker] tick failed:', error);
    } finally {
      workerTimer = setTimeout(loop, 250);
    }
  };

  void loop();
}

export function stopQueueWorker(): void {
  workerRunning = false;
  workerStartAttempted = false;
  if (workerTimer) {
    clearTimeout(workerTimer);
    workerTimer = null;
  }
  console.log('[queue-worker] stopped');
}

export function isQueueWorkerRunning(): boolean {
  return workerRunning;
}

export async function runQueueWorkerForever(): Promise<void> {
  const connected = await connectRedis();
  if (!connected) {
    throw new Error('Cannot start dedicated worker — Redis is unavailable');
  }

  workerRunning = true;
  console.log('[queue-worker] dedicated worker running');

  while (workerRunning) {
    try {
      const emailTask = await popEmailTask(QUEUE_CONFIG.workerPollSeconds);
      if (emailTask) {
        await processEmailTask(emailTask);
        continue;
      }

      const uploadTask = await popUploadTask(1);
      if (uploadTask) {
        await processUploadTask(uploadTask);
      }
    } catch (error) {
      console.error('[queue-worker] loop error:', error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
