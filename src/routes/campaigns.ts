import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import {
  campaigns, users,
  CAMPAIGN_STATUSES, CAMPAIGN_TYPES,
} from '../db/schema.js';
import { eq, desc, inArray, sql } from 'drizzle-orm';
import { requireAuth, requireRole, type AppContext } from '../middleware.js';
import { getOrgMemberIds } from '../lib/orgScope.js';
import { parsePagination, paginateInMemory } from '../lib/pagination.js';
import { MS_PER_DAY, RECENT_DAYS } from '../config.js';
import { belongsToOrganization } from '../lib/orgScope.js';
import { enqueueEmailBatch } from '../queue/email-queue.js';
import { personalizeCampaignBody, wrapCampaignHtml } from '../queue/email-service.js';

async function getCampaignForUser(
  id: number,
  userId: number,
  orgId: number | null,
) {
  const [campaign] = await db.select().from(campaigns).where(eq(campaigns.id, id)).limit(1);
  if (!campaign) return null;

  const allowed = belongsToOrganization(
    campaign.organizationId,
    orgId,
    campaign.createdBy,
    userId,
  );
  return allowed ? campaign : null;
}

const campaignsRouter = new Hono<AppContext>({ strict: false });

type CampStatus = typeof CAMPAIGN_STATUSES[number];
type CampType = typeof CAMPAIGN_TYPES[number];

const STATUS_LABELS: Record<CampStatus, string> = {
  draft: 'Draft', scheduled: 'Scheduled', sent: 'Sent',
};
const TYPE_LABELS: Record<CampType, string> = {
  hotlist: 'Hot List', job_campaign: 'Job Campaign',
};

const recipientSchema = z.object({
  email: z.string(),
  name: z.string().optional(),
  candidateId: z.number().int().positive().optional(),
});

async function enrichCampaign(row: typeof campaigns.$inferSelect) {
  let creatorName = '';
  if (row.createdBy) {
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, row.createdBy));
    creatorName = u?.name ?? '';
  }
  const recipients = JSON.parse(row.recipientsJson || '[]') as z.infer<typeof recipientSchema>[];

  return {
    ...row,
    recipients,
    creatorName,
    statusLabel: STATUS_LABELS[row.status as CampStatus] ?? row.status,
    typeLabel: TYPE_LABELS[row.type as CampType] ?? row.type,
  };
}

const campaignBody = z.object({
  name: z.string().min(1, 'Campaign name is required'),
  type: z.enum(CAMPAIGN_TYPES).optional(),
  status: z.enum(CAMPAIGN_STATUSES).optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  recipients: z.array(recipientSchema).optional(),
  scheduledAt: z.string().optional(),
});

/* GET /campaigns */
campaignsRouter.get('/', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const typeFilter = c.req.query('type') ?? 'all';
    const statusFilter = c.req.query('status');
    const search = c.req.query('search')?.trim().toLowerCase() ?? '';
    const { page, pageSize } = parsePagination(c.req.query());

    const memberIds = await getOrgMemberIds(orgId, userId);
    if (memberIds.length === 0) return c.json({ data: [], total: 0, page, pageSize });

    let rows = await db.select().from(campaigns)
      .where(inArray(campaigns.createdBy, memberIds))
      .orderBy(desc(campaigns.updatedAt));

    if (typeFilter !== 'all') rows = rows.filter((r) => r.type === typeFilter);
    if (statusFilter && statusFilter !== 'all') rows = rows.filter((r) => r.status === statusFilter);

    const enriched = await Promise.all(rows.map(enrichCampaign));
    const filtered = search
      ? enriched.filter((c) => {
          const blob = `${c.name} ${c.subject} ${c.creatorName}`.toLowerCase();
          return blob.includes(search);
        })
      : enriched;

    return c.json(paginateInMemory(filtered, page, pageSize));
  } catch {
    return c.json({ error: 'Failed to fetch campaigns' }, 500);
  }
});

/* GET /campaigns/:id */
campaignsRouter.get('/:id', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const row = await getCampaignForUser(id, userId, orgId);
    if (!row) return c.json({ error: 'Campaign not found' }, 404);
    return c.json(await enrichCampaign(row));
  } catch {
    return c.json({ error: 'Failed to fetch campaign' }, 500);
  }
});

/* POST /campaigns */
campaignsRouter.post('/', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), zValidator('json', campaignBody), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const b = c.req.valid('json');
    const now = new Date().toISOString();
    const recipients = b.recipients ?? [];

    const [created] = await db.insert(campaigns).values({
      name: b.name,
      type: b.type ?? 'hotlist',
      status: b.status ?? 'draft',
      subject: b.subject ?? '',
      body: b.body ?? '',
      recipientsJson: JSON.stringify(recipients),
      recipientCount: recipients.length,
      scheduledAt: b.scheduledAt ?? '',
      organizationId: orgId,
      createdBy: userId,
      updatedAt: now,
    }).returning();

    return c.json(await enrichCampaign(created), 201);
  } catch {
    return c.json({ error: 'Failed to create campaign' }, 500);
  }
});

/* PUT /campaigns/:id */
campaignsRouter.put('/:id', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), zValidator('json', campaignBody.partial()), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const existing = await getCampaignForUser(id, userId, orgId);
    if (!existing) return c.json({ error: 'Campaign not found' }, 404);

    const b = c.req.valid('json');
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (b.name !== undefined) patch.name = b.name;
    if (b.type !== undefined) patch.type = b.type;
    if (b.status !== undefined) {
      patch.status = b.status;
      if (b.status === 'sent') patch.sentAt = new Date().toISOString();
    }
    if (b.subject !== undefined) patch.subject = b.subject;
    if (b.body !== undefined) patch.body = b.body;
    if (b.scheduledAt !== undefined) patch.scheduledAt = b.scheduledAt;
    if (b.recipients !== undefined) {
      patch.recipientsJson = JSON.stringify(b.recipients);
      patch.recipientCount = b.recipients.length;
    }

    const [updated] = await db.update(campaigns).set(patch as any).where(eq(campaigns.id, id)).returning();
    if (!updated) return c.json({ error: 'Campaign not found' }, 404);
    return c.json(await enrichCampaign(updated));
  } catch {
    return c.json({ error: 'Failed to update campaign' }, 500);
  }
});

/* POST /campaigns/:id/send — enqueue all recipients, return 202 */
campaignsRouter.post('/:id/send', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;

    const campaign = await getCampaignForUser(id, userId, orgId);
    if (!campaign) return c.json({ error: 'Campaign not found' }, 404);

    if (campaign.status === 'sent') {
      return c.json({ error: 'Campaign has already been sent' }, 409);
    }

    const recipients = JSON.parse(campaign.recipientsJson || '[]') as z.infer<typeof recipientSchema>[];
    if (recipients.length === 0) {
      return c.json({ error: 'Campaign has no recipients' }, 400);
    }
    if (!campaign.subject?.trim()) {
      return c.json({ error: 'Campaign subject is required before sending' }, 400);
    }
    if (!campaign.body?.trim()) {
      return c.json({ error: 'Campaign body is required before sending' }, 400);
    }

    const now = new Date().toISOString();
    const subject = campaign.subject.trim();
    const bodyHtml = campaign.body.trim();

    const batchItems = recipients
      .filter((r) => r.email?.trim())
      .map((recipient) => ({
        type: 'campaign' as const,
        to: recipient.email.trim(),
        subject,
        html: wrapCampaignHtml(personalizeCampaignBody(bodyHtml, recipient.name)),
        metadata: {
          campaignId: id,
          recipientName: recipient.name,
          candidateId: recipient.candidateId,
        },
      }));

    if (batchItems.length === 0) {
      return c.json({ error: 'No valid recipient emails found' }, 400);
    }

    const { batchId, queued, inline } = await enqueueEmailBatch(batchItems, {
      campaignId: id,
      label: `Campaign: ${campaign.name}`,
      organizationId: campaign.organizationId,
      createdBy: userId,
    });

    const [updated] = await db.update(campaigns).set({
      status: 'sent',
      sentAt: now,
      updatedAt: now,
    }).where(eq(campaigns.id, id)).returning();

    return c.json({
      ...(await enrichCampaign(updated)),
      batchId,
      emailStatus: 'queued',
      queued,
      inline,
    }, 202);
  } catch (error) {
    console.error('[campaigns/send]', error);
    return c.json({ error: 'Failed to send campaign' }, 500);
  }
});

/* DELETE /campaigns/:id */
campaignsRouter.delete('/:id', requireAuth, requireRole('recruiter_admin'), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const existing = await getCampaignForUser(id, userId, orgId);
    if (!existing) return c.json({ error: 'Campaign not found' }, 404);
    await db.delete(campaigns).where(eq(campaigns.id, id));
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'Failed to delete campaign' }, 500);
  }
});

export default campaignsRouter;
