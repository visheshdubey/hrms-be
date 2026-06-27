import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import { integrations, INTEGRATION_PLATFORMS } from '../db/schema.js';
import { eq, and } from 'drizzle-orm';
import { requireAuth, requireRecruiter, type AppContext } from '../middleware.js';

const integrationsRouter = new Hono<AppContext>({ strict: false });

const integrationBody = z.object({
  platform: z.enum(INTEGRATION_PLATFORMS),
  label: z.string().min(1, 'Label is required'),
  apiKey: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  isActive: z.boolean().optional(),
});

function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 4) return '****';
  return `${'*'.repeat(key.length - 4)}${key.slice(-4)}`;
}

function enrichIntegration(row: typeof integrations.$inferSelect, revealKey = false) {
  let config: Record<string, unknown> = {};
  try { config = JSON.parse(row.configJson || '{}'); } catch { /* noop */ }

  return {
    ...row,
    apiKey: revealKey ? row.apiKey : maskApiKey(row.apiKey ?? ''),
    config,
    isActive: Boolean(row.isActive),
  };
}

/* GET /settings/integrations */
integrationsRouter.get('/', requireAuth, requireRecruiter, async (c) => {
  try {
    const orgId = c.get('organizationId') as number | null;
    if (!orgId) return c.json({ data: [] });

    const rows = await db.select().from(integrations).where(eq(integrations.organizationId, orgId));
    return c.json({ data: rows.map((r) => enrichIntegration(r)) });
  } catch {
    return c.json({ error: 'Failed to fetch integrations' }, 500);
  }
});

/* GET /settings/integrations/:id — includes masked key only */
integrationsRouter.get('/:id', requireAuth, requireRecruiter, async (c) => {
  try {
    const orgId = c.get('organizationId') as number | null;
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const [row] = await db.select().from(integrations)
      .where(and(eq(integrations.id, id), eq(integrations.organizationId, orgId!))).limit(1);
    if (!row) return c.json({ error: 'Integration not found' }, 404);

    return c.json(enrichIntegration(row));
  } catch {
    return c.json({ error: 'Failed to fetch integration' }, 500);
  }
});

/* POST /settings/integrations */
integrationsRouter.post('/', requireAuth, requireRecruiter, zValidator('json', integrationBody), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    if (!orgId) return c.json({ error: 'No organization' }, 404);

    const b = c.req.valid('json');
    const now = new Date().toISOString();

    const [created] = await db.insert(integrations).values({
      organizationId: orgId,
      platform: b.platform,
      label: b.label,
      apiKey: b.apiKey ?? '',
      configJson: JSON.stringify(b.config ?? {}),
      isActive: b.isActive === false ? 0 : 1,
      createdBy: userId,
      updatedAt: now,
    }).returning();

    return c.json(enrichIntegration(created), 201);
  } catch {
    return c.json({ error: 'Failed to create integration' }, 500);
  }
});

/* PUT /settings/integrations/:id */
integrationsRouter.put('/:id', requireAuth, requireRecruiter, zValidator('json', integrationBody.partial()), async (c) => {
  try {
    const orgId = c.get('organizationId') as number | null;
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const [existing] = await db.select().from(integrations)
      .where(and(eq(integrations.id, id), eq(integrations.organizationId, orgId!))).limit(1);
    if (!existing) return c.json({ error: 'Integration not found' }, 404);

    const b = c.req.valid('json');
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (b.platform !== undefined) patch.platform = b.platform;
    if (b.label !== undefined) patch.label = b.label;
    if (b.apiKey !== undefined) patch.apiKey = b.apiKey;
    if (b.config !== undefined) patch.configJson = JSON.stringify(b.config);
    if (b.isActive !== undefined) patch.isActive = b.isActive ? 1 : 0;

    const [updated] = await db.update(integrations).set(patch as typeof integrations.$inferInsert)
      .where(eq(integrations.id, id)).returning();
    return c.json(enrichIntegration(updated));
  } catch {
    return c.json({ error: 'Failed to update integration' }, 500);
  }
});

/* DELETE /settings/integrations/:id */
integrationsRouter.delete('/:id', requireAuth, requireRecruiter, async (c) => {
  try {
    const orgId = c.get('organizationId') as number | null;
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    await db.delete(integrations)
      .where(and(eq(integrations.id, id), eq(integrations.organizationId, orgId!)));
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'Failed to delete integration' }, 500);
  }
});

export default integrationsRouter;
