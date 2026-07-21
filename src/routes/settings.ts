import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import {
  orgSettings, rolesPermissions, organizations,
  ACCESS_CONTROL_TYPES,
} from '../db/schema.js';
import { and, eq, desc } from 'drizzle-orm';
import { requireAuth, requireRole, type AppContext } from '../middleware.js';
import { getAccessibleAccountIds } from '../lib/orgScope.js';
import tagsRoutes from './tags.js';
import integrationsRoutes from './integrations.js';

const settingsRouter = new Hono<AppContext>({ strict: false });

settingsRouter.route('/tags', tagsRoutes);
settingsRouter.route('/integrations', integrationsRoutes);

type AccessType = typeof ACCESS_CONTROL_TYPES[number];

const configurationsSchema = z.record(z.string(), z.unknown()).optional();

const orgSettingsBody = z.object({
  website: z.string().optional(),
  description: z.string().optional(),
  contactPhone: z.string().optional(),
  contactEmail: z.string().optional(),
  logoUrl: z.string().optional(),
  faviconUrl: z.string().optional(),
  primaryColor: z.string().optional(),
  billingCompany: z.string().optional(),
  billingAddress: z.string().optional(),
  billingCity: z.string().optional(),
  billingState: z.string().optional(),
  billingCountry: z.string().optional(),
  billingZip: z.string().optional(),
  country: z.string().optional(),
  currency: z.string().optional(),
  timezone: z.string().optional(),
  dateFormat: z.string().optional(),
  timeFormat: z.enum(['12h', '24h']).optional(),
  emailDomain: z.string().optional(),
  spfRecord: z.string().optional(),
  dkimRecord: z.string().optional(),
  dkimVerified: z.boolean().optional(),
  inboxForwardEmail: z.string().optional(),
  parseResumes: z.boolean().optional(),
  configurations: configurationsSchema,
});

const permissionBody = z.object({
  type: z.enum(ACCESS_CONTROL_TYPES),
  name: z.string().min(1, 'Name is required'),
  description: z.string().optional(),
  permissions: z.record(z.string(), z.unknown()).optional(),
  members: z.array(z.union([z.number(), z.string()])).optional(),
  ipAddresses: z.array(z.string()).optional(),
  reportIds: z.array(z.string()).optional(),
  isActive: z.boolean().optional(),
});

async function getOrCreateOrgSettings(orgId: number, orgName: string) {
  const [existing] = await db.select().from(orgSettings).where(eq(orgSettings.organizationId, orgId)).limit(1);
  if (existing) return existing;

  const [created] = await db.insert(orgSettings).values({
    organizationId: orgId,
    billingCompany: orgName,
    updatedAt: new Date().toISOString(),
  }).returning();
  return created;
}

function enrichOrgSettings(row: typeof orgSettings.$inferSelect, orgName: string) {
  let configurations: Record<string, unknown> = {};
  try { configurations = JSON.parse(row.configurationsJson || '{}'); } catch { /* noop */ }

  return {
    ...row,
    organizationName: orgName,
    dkimVerified: Boolean(row.dkimVerified),
    parseResumes: Boolean(row.parseResumes),
    configurations,
  };
}

function enrichPermission(row: typeof rolesPermissions.$inferSelect) {
  const parse = <T>(json: string | null, fallback: T): T => {
    try { return JSON.parse(json ?? '') as T; } catch { return fallback; }
  };
  return {
    ...row,
    permissions: parse(row.permissionsJson, {}),
    members: parse(row.membersJson, []),
    ipAddresses: parse(row.ipAddressesJson, []),
    reportIds: parse(row.reportIdsJson, []),
    isActive: Boolean(row.isActive),
  };
}

/* GET /settings/org */
settingsRouter.get('/org', requireAuth, requireRole('org_admin'), async (c) => {
  try {
    const orgId = c.get('organizationId') as number | null;
    if (!orgId) return c.json({ error: 'No organization' }, 404);

    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (!org) return c.json({ error: 'Organization not found' }, 404);

    const row = await getOrCreateOrgSettings(orgId, org.name);
    return c.json(enrichOrgSettings(row, org.name));
  } catch {
    return c.json({ error: 'Failed to fetch org settings' }, 500);
  }
});

/* PUT /settings/org */
settingsRouter.put('/org', requireAuth, requireRole('org_admin'), zValidator('json', orgSettingsBody), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    if (!orgId) return c.json({ error: 'No organization' }, 404);

    const [org] = await db.select().from(organizations).where(eq(organizations.id, orgId)).limit(1);
    if (!org) return c.json({ error: 'Organization not found' }, 404);

    const b = c.req.valid('json');
    await getOrCreateOrgSettings(orgId, org.name);

    const patch: Record<string, unknown> = {
      updatedBy: userId,
      updatedAt: new Date().toISOString(),
    };

    const scalarFields = [
      'website','description','contactPhone','contactEmail','logoUrl','faviconUrl','primaryColor',
      'billingCompany','billingAddress','billingCity','billingState','billingCountry','billingZip',
      'country','currency','timezone','dateFormat','timeFormat','emailDomain','spfRecord','dkimRecord',
      'inboxForwardEmail',
    ] as const;

    for (const k of scalarFields) {
      if (b[k] !== undefined) patch[k] = b[k];
    }
    if (b.dkimVerified !== undefined) patch.dkimVerified = b.dkimVerified ? 1 : 0;
    if (b.parseResumes !== undefined) patch.parseResumes = b.parseResumes ? 1 : 0;
    if (b.configurations !== undefined) patch.configurationsJson = JSON.stringify(b.configurations);

    const [updated] = await db.update(orgSettings).set(patch as any)
      .where(eq(orgSettings.organizationId, orgId)).returning();

    return c.json(enrichOrgSettings(updated, org.name));
  } catch {
    return c.json({ error: 'Failed to update org settings' }, 500);
  }
});

/* GET /settings/permissions */
settingsRouter.get('/permissions', requireAuth, requireRole('org_admin'), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    if (!orgId) return c.json({ data: [] });
    const [accountId] = await getAccessibleAccountIds(userId, orgId, 'org_admin');
    if (!accountId) return c.json({ data: [] });

    const typeFilter = c.req.query('type') as AccessType | undefined;
    let rows = await db.select().from(rolesPermissions)
      .where(and(
        eq(rolesPermissions.organizationId, orgId),
        eq(rolesPermissions.accountId, accountId),
      ))
      .orderBy(desc(rolesPermissions.updatedAt));

    if (typeFilter) rows = rows.filter((r) => r.type === typeFilter);

    return c.json({ data: rows.map(enrichPermission) });
  } catch {
    return c.json({ error: 'Failed to fetch permissions' }, 500);
  }
});

/* POST /settings/permissions */
settingsRouter.post('/permissions', requireAuth, requireRole('org_admin'), zValidator('json', permissionBody), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    if (!orgId) return c.json({ error: 'No organization' }, 404);
    const [accountId] = await getAccessibleAccountIds(userId, orgId, 'org_admin');
    if (!accountId) return c.json({ error: 'No linked client account' }, 404);

    const b = c.req.valid('json');
    const now = new Date().toISOString();

    const [created] = await db.insert(rolesPermissions).values({
      organizationId: orgId,
      accountId,
      type: b.type,
      name: b.name,
      description: b.description ?? '',
      permissionsJson: JSON.stringify(b.permissions ?? {}),
      membersJson: JSON.stringify(b.members ?? []),
      ipAddressesJson: JSON.stringify(b.ipAddresses ?? []),
      reportIdsJson: JSON.stringify(b.reportIds ?? []),
      isActive: b.isActive === false ? 0 : 1,
      createdBy: userId,
      updatedAt: now,
    }).returning();

    return c.json(enrichPermission(created), 201);
  } catch {
    return c.json({ error: 'Failed to create permission record' }, 500);
  }
});

/* PUT /settings/permissions/:id */
settingsRouter.put('/permissions/:id', requireAuth, requireRole('org_admin'), zValidator('json', permissionBody.partial()), async (c) => {
  try {
    const orgId = c.get('organizationId') as number | null;
    if (!orgId) return c.json({ error: 'No organization' }, 404);
    const userId = c.get('userId') as number;
    const [accountId] = await getAccessibleAccountIds(userId, orgId, 'org_admin');
    if (!accountId) return c.json({ error: 'No linked client account' }, 404);
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    const b = c.req.valid('json');
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };

    if (b.type !== undefined) patch.type = b.type;
    if (b.name !== undefined) patch.name = b.name;
    if (b.description !== undefined) patch.description = b.description;
    if (b.permissions !== undefined) patch.permissionsJson = JSON.stringify(b.permissions);
    if (b.members !== undefined) patch.membersJson = JSON.stringify(b.members);
    if (b.ipAddresses !== undefined) patch.ipAddressesJson = JSON.stringify(b.ipAddresses);
    if (b.reportIds !== undefined) patch.reportIdsJson = JSON.stringify(b.reportIds);
    if (b.isActive !== undefined) patch.isActive = b.isActive ? 1 : 0;

    const [updated] = await db.update(rolesPermissions).set(patch as any)
      .where(and(
        eq(rolesPermissions.id, id),
        eq(rolesPermissions.organizationId, orgId),
        eq(rolesPermissions.accountId, accountId),
      )).returning();
    if (!updated) return c.json({ error: 'Record not found' }, 404);
    return c.json(enrichPermission(updated));
  } catch {
    return c.json({ error: 'Failed to update permission record' }, 500);
  }
});

/* DELETE /settings/permissions/:id */
settingsRouter.delete('/permissions/:id', requireAuth, requireRole('org_admin'), async (c) => {
  try {
    const orgId = c.get('organizationId') as number | null;
    if (!orgId) return c.json({ error: 'No organization' }, 404);
    const userId = c.get('userId') as number;
    const [accountId] = await getAccessibleAccountIds(userId, orgId, 'org_admin');
    if (!accountId) return c.json({ error: 'No linked client account' }, 404);
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    const [deleted] = await db.delete(rolesPermissions)
      .where(and(
        eq(rolesPermissions.id, id),
        eq(rolesPermissions.organizationId, orgId),
        eq(rolesPermissions.accountId, accountId),
      ))
      .returning({ id: rolesPermissions.id });
    if (!deleted) return c.json({ error: 'Record not found' }, 404);
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'Failed to delete permission record' }, 500);
  }
});

export default settingsRouter;
