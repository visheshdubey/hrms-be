import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { requireAuth, requireRole, type AppContext } from '../middleware.js';
import { canAccessBatch } from '../queue/access.js';
import { enqueueEmailBatch, getEmailQueueDepth } from '../queue/email-queue.js';
import { personalizeCampaignBody, wrapCampaignHtml } from '../queue/email-service.js';
import { getBatchJob } from '../queue/task-status.js';
import { getUploadQueueDepth } from '../queue/upload-queue.js';
import { isQueueWorkerRunning } from '../queue/worker.js';
import { getLastRedisHealth, isRedisHealthy } from '../queue/redis.js';

const queueRouter = new Hono<AppContext>({ strict: false });

queueRouter.get('/health', requireAuth, requireRole('recruiter_admin', 'org_admin'), async (c) => {
  try {
    const redisOk = await isRedisHealthy();
    const emailDepth = redisOk ? await getEmailQueueDepth() : { pending: 0, deadLetter: 0 };
    const uploadDepth = redisOk ? await getUploadQueueDepth() : 0;

    return c.json({
      redis: {
        connected: redisOk,
        lastCheck: getLastRedisHealth(),
      },
      worker: {
        running: isQueueWorkerRunning(),
      },
      queues: {
        email: emailDepth,
        upload: { pending: uploadDepth },
      },
    });
  } catch (error) {
    console.error('[queue/health]', error);
    return c.json({ error: 'Failed to read queue health' }, 500);
  }
});

queueRouter.get('/batches/:id', requireAuth, requireRole('recruiter_admin', 'recruited_staff', 'org_admin'), async (c) => {
  try {
    const batchId = c.req.param('id');
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;

    const batch = await getBatchJob(batchId);
    if (!batch) return c.json({ error: 'Batch not found' }, 404);
    if (!canAccessBatch(batch, userId, orgId)) {
      return c.json({ error: 'Batch not found' }, 404);
    }

    return c.json(batch);
  } catch (error) {
    console.error('[queue/batches/:id]', error);
    return c.json({ error: 'Failed to fetch batch status' }, 500);
  }
});

const bulkEmailSchema = z.object({
  subject: z.string().min(1),
  html: z.string().min(1),
  recipients: z.array(z.object({
    email: z.string().email(),
    name: z.string().optional(),
  })).min(1).max(10_000),
  label: z.string().optional(),
});

queueRouter.post(
  '/emails/bulk',
  requireAuth,
  requireRole('recruiter_admin'),
  zValidator('json', bulkEmailSchema),
  async (c) => {
    try {
      const body = c.req.valid('json');
      const userId = c.get('userId') as number;
      const orgId = c.get('organizationId') as number | null;

      const result = await enqueueEmailBatch(
        body.recipients.map((recipient) => ({
          type: 'generic' as const,
          to: recipient.email,
          subject: body.subject,
          html: wrapCampaignHtml(personalizeCampaignBody(body.html, recipient.name)),
          metadata: { recipientName: recipient.name },
        })),
        {
          label: body.label ?? 'Bulk email',
          organizationId: orgId,
          createdBy: userId,
        },
      );

      return c.json({
        batchId: result.batchId,
        status: 'queued',
        total: body.recipients.length,
        queued: result.queued,
        inline: result.inline,
      }, 202);
    } catch (error) {
      console.error('[queue/emails/bulk]', error);
      return c.json({ error: 'Failed to enqueue bulk emails' }, 500);
    }
  },
);

export default queueRouter;
