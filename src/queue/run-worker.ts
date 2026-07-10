import 'dotenv/config';
import { runQueueWorkerForever } from './worker.js';

runQueueWorkerForever().catch((error) => {
  console.error('[queue-worker] fatal:', error);
  process.exit(1);
});
