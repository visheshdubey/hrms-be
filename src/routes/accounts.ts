import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import { accounts, contacts, users, jobs, accountStageTemplates, JOB_STAGE_TYPES, ACCOUNT_STATUSES, ACCOUNT_TYPES } from '../db/schema.js';
import { eq, desc, sql, and, inArray, type SQL } from 'drizzle-orm';
import { requireAuth, requireRole, type AppContext, type UserRole } from '../middleware.js';
import { belongsToOrganization, orgOrCreatorScope, getOrgMemberIds } from '../lib/orgScope.js';
import {
  applyTemplatesToAccountJobsWithoutStages,
  canWriteStageTemplates,
  getAccountIfAccessible,
} from '../lib/stages.js';
import { cascadeDeleteAccount, getAccountDeletePreview } from '../lib/accountDelete.js';
import { parsePagination, paginateInMemory } from '../lib/pagination.js';
import { MS_PER_DAY, RECENT_DAYS } from '../config.js';
import { defaultStageColor } from '../lib/stageColors.js';

const accountsRouter = new Hono<AppContext>({ strict: false });

type AccStatus = typeof ACCOUNT_STATUSES[number];
type AccType = typeof ACCOUNT_TYPES[number];

const STATUS_LABELS: Record<AccStatus, string> = {
  active: 'Active', inactive: 'Inactive', on_hold: 'On Hold',
};
const TYPE_LABELS: Record<AccType, string> = {
  client: 'Client', client_vendor: 'Client/Vendor', vendor: 'Vendor', prospect: 'Prospect',
};

async function enrichAccount(row: typeof accounts.$inferSelect) {
  let ownerName = '';
  if (row.createdBy) {
    try {
      const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, row.createdBy));
      ownerName = u?.name ?? '';
    } catch {
      ownerName = '';
    }
  }

  let contactCount = 0;
  try {
    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(contacts)
      .where(eq(contacts.accountId, row.id));
    contactCount = Number(countRow?.count ?? 0);
  } catch {
    contactCount = 0;
  }

  let parsedTags: string[] = [];
  try {
    const raw = JSON.parse(row.tags ?? '[]');
    if (Array.isArray(raw)) parsedTags = raw.map((v) => String(v)).filter(Boolean);
  } catch {}

  return {
    ...row,
    tags: parsedTags,
    alertsEnabled: Boolean(row.alertsEnabled),
    ownerName,
    contactCount,
    statusLabel: STATUS_LABELS[row.status as AccStatus] ?? row.status,
    typeLabel: TYPE_LABELS[row.type as AccType] ?? row.type,
  };
}

function isAccountsSchemaDriftError(error: unknown): boolean {
  const message = String(error ?? '').toLowerCase();
  return message.includes('does not exist');
}

const LEGACY_ACCOUNT_SELECT = {
  id: accounts.id,
  name: accounts.name,
  status: accounts.status,
  type: accounts.type,
  website: accounts.website,
  description: accounts.description,
  phone: accounts.phone,
  email: accounts.email,
  address: accounts.address,
  city: accounts.city,
  state: accounts.state,
  country: accounts.country,
  createdBy: accounts.createdBy,
  createdAt: accounts.createdAt,
  updatedAt: accounts.updatedAt,
} as const;

function withLegacyAccountDefaults<T extends Record<string, unknown>>(row: T) {
  return {
    ...row,
    contractValue: 0,
    tags: '[]',
    alertsEnabled: 0,
    shortLogoUrl: '',
    longLogoUrl: '',
    organizationId: null as number | null,
  };
}

async function legacyAccountsScope(
  orgId: number | null,
  userId: number,
): Promise<SQL | undefined> {
  if (orgId != null) {
    const memberIds = await getOrgMemberIds(orgId, userId);
    if (memberIds.length === 0) return eq(accounts.createdBy, userId);
    return inArray(accounts.createdBy, memberIds);
  }
  return eq(accounts.createdBy, userId);
}

async function listAccountsLegacy(orgId: number | null, userId: number) {
  const scope = await legacyAccountsScope(orgId, userId);
  const rows = await db
    .select(LEGACY_ACCOUNT_SELECT)
    .from(accounts)
    .where(scope)
    .orderBy(desc(accounts.updatedAt));
  return rows.map(withLegacyAccountDefaults);
}

async function getAccountByIdLegacy(id: number) {
  const rows = await db
    .select(LEGACY_ACCOUNT_SELECT)
    .from(accounts)
    .where(eq(accounts.id, id))
    .limit(1);
  return rows.map(withLegacyAccountDefaults);
}

async function listAccountsSafe(orgId: number | null, userId: number) {
  const scope = orgOrCreatorScope(orgId, userId, accounts, accounts);
  try {
    return await db
      .select({
        ...LEGACY_ACCOUNT_SELECT,
        contractValue: accounts.contractValue,
        tags: accounts.tags,
        alertsEnabled: accounts.alertsEnabled,
        shortLogoUrl: accounts.shortLogoUrl,
        longLogoUrl: accounts.longLogoUrl,
        organizationId: accounts.organizationId,
      })
      .from(accounts)
      .where(scope)
      .orderBy(desc(accounts.updatedAt));
  } catch (error) {
    if (!isAccountsSchemaDriftError(error)) throw error;
    return listAccountsLegacy(orgId, userId);
  }
}

async function getAccountByIdSafe(id: number) {
  try {
    const rows = await db
      .select({
        ...LEGACY_ACCOUNT_SELECT,
        contractValue: accounts.contractValue,
        tags: accounts.tags,
        alertsEnabled: accounts.alertsEnabled,
        shortLogoUrl: accounts.shortLogoUrl,
        longLogoUrl: accounts.longLogoUrl,
        organizationId: accounts.organizationId,
      })
      .from(accounts)
      .where(eq(accounts.id, id))
      .limit(1);
    return rows;
  } catch (error) {
    if (!isAccountsSchemaDriftError(error)) throw error;
    return getAccountByIdLegacy(id);
  }
}

const accountBody = z.object({
  name: z.string().min(1, 'Account name is required'),
  status: z.enum(ACCOUNT_STATUSES).optional(),
  type: z.enum(ACCOUNT_TYPES).optional(),
  contractValue: z.number().int().nonnegative().optional(),
  tags: z.array(z.string()).optional(),
  alertsEnabled: z.boolean().optional(),
  website: z.string().optional(),
  description: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  shortLogoUrl: z.string().optional(),
  longLogoUrl: z.string().optional(),
});

const mergeSchema = z.object({
  targetId: z.number().int().positive(),
  sourceIds: z.array(z.number().int().positive()).min(1),
});

const stageTemplateSchema = z.object({
  name: z.string().min(1),
  orderIndex: z.number().int().nonnegative().optional(),
  stageType: z.enum(JOB_STAGE_TYPES).optional(),
  color: z.string().min(4).max(32).optional(),
});

const reorderStageTemplatesSchema = z.object({
  stageIds: z.array(z.number().int().positive()).min(1),
});

function stageWriteForbidden(c: { json: (body: unknown, status?: number) => Response }) {
  return c.json({ error: 'Only admins can modify stage templates' }, 403);
}

/* GET /accounts/options — lightweight list for stage settings */
accountsRouter.get('/options', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;

    const rows = await db
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(orgOrCreatorScope(orgId, userId, accounts, accounts))
      .orderBy(desc(accounts.updatedAt));

    return c.json({ data: rows });
  } catch {
    return c.json({ error: 'Failed to fetch account options' }, 500);
  }
});

/* GET /accounts/:id/stage-templates */
accountsRouter.get('/:id/stage-templates', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const accountId = parseInt(c.req.param('id'));
    if (isNaN(accountId)) return c.json({ error: 'Invalid account id' }, 400);

    const account = await getAccountIfAccessible(accountId, userId, orgId);
    if (!account) return c.json({ error: 'Account not found or unauthorized' }, 403);

    const stages = await db
      .select()
      .from(accountStageTemplates)
      .where(eq(accountStageTemplates.accountId, accountId))
      .orderBy(accountStageTemplates.orderIndex);

    return c.json({ data: stages });
  } catch {
    return c.json({ error: 'Failed to fetch stage templates' }, 500);
  }
});

/* POST /accounts/:id/stage-templates */
accountsRouter.post('/:id/stage-templates', requireAuth, zValidator('json', stageTemplateSchema), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const accountId = parseInt(c.req.param('id'));
    if (isNaN(accountId)) return c.json({ error: 'Invalid account id' }, 400);
    if (!canWriteStageTemplates(role)) return stageWriteForbidden(c);

    const account = await getAccountIfAccessible(accountId, userId, orgId);
    if (!account) return c.json({ error: 'Account not found or unauthorized' }, 403);

    const body = c.req.valid('json');
    const orderIndex = body.orderIndex ?? 0;
    const [created] = await db.insert(accountStageTemplates).values({
      accountId,
      name: body.name,
      orderIndex,
      stageType: body.stageType ?? 'application',
      color: body.color ?? defaultStageColor(orderIndex),
    }).returning();

    return c.json(created, 201);
  } catch {
    return c.json({ error: 'Failed to create stage template' }, 500);
  }
});

/* PUT /accounts/:id/stage-templates/:stageId */
accountsRouter.put('/:id/stage-templates/:stageId', requireAuth, zValidator('json', stageTemplateSchema.partial()), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const accountId = parseInt(c.req.param('id'));
    const stageId = parseInt(c.req.param('stageId'));
    if (isNaN(accountId) || isNaN(stageId)) return c.json({ error: 'Invalid id' }, 400);
    if (!canWriteStageTemplates(role)) return stageWriteForbidden(c);

    const account = await getAccountIfAccessible(accountId, userId, orgId);
    if (!account) return c.json({ error: 'Account not found or unauthorized' }, 403);

    const body = c.req.valid('json');
    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.orderIndex !== undefined) patch.orderIndex = body.orderIndex;
    if (body.stageType !== undefined) patch.stageType = body.stageType;
    if (body.color !== undefined) patch.color = body.color;

    const [updated] = await db
      .update(accountStageTemplates)
      .set(patch as typeof accountStageTemplates.$inferInsert)
      .where(and(eq(accountStageTemplates.id, stageId), eq(accountStageTemplates.accountId, accountId)))
      .returning();

    if (!updated) return c.json({ error: 'Stage template not found' }, 404);
    return c.json(updated);
  } catch {
    return c.json({ error: 'Failed to update stage template' }, 500);
  }
});

/* DELETE /accounts/:id/stage-templates/:stageId */
accountsRouter.delete('/:id/stage-templates/:stageId', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const accountId = parseInt(c.req.param('id'));
    const stageId = parseInt(c.req.param('stageId'));
    if (isNaN(accountId) || isNaN(stageId)) return c.json({ error: 'Invalid id' }, 400);
    if (!canWriteStageTemplates(role)) return stageWriteForbidden(c);

    const account = await getAccountIfAccessible(accountId, userId, orgId);
    if (!account) return c.json({ error: 'Account not found or unauthorized' }, 403);

    const [deleted] = await db
      .delete(accountStageTemplates)
      .where(and(eq(accountStageTemplates.id, stageId), eq(accountStageTemplates.accountId, accountId)))
      .returning();

    if (!deleted) return c.json({ error: 'Stage template not found' }, 404);
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'Failed to delete stage template' }, 500);
  }
});

/* PUT /accounts/:id/stage-templates/reorder — batch reorder after drag-and-drop */
accountsRouter.put('/:id/stage-templates/reorder', requireAuth, zValidator('json', reorderStageTemplatesSchema), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const accountId = parseInt(c.req.param('id'));
    if (isNaN(accountId)) return c.json({ error: 'Invalid account id' }, 400);
    if (!canWriteStageTemplates(role)) return stageWriteForbidden(c);

    const account = await getAccountIfAccessible(accountId, userId, orgId);
    if (!account) return c.json({ error: 'Account not found or unauthorized' }, 403);

    const { stageIds } = c.req.valid('json');
    const existing = await db
      .select({ id: accountStageTemplates.id })
      .from(accountStageTemplates)
      .where(eq(accountStageTemplates.accountId, accountId));

    if (existing.length === 0) {
      return c.json({ error: 'No stage templates to reorder' }, 400);
    }

    if (stageIds.length !== existing.length) {
      return c.json({ error: 'stageIds must include every template for this account' }, 400);
    }

    const existingIdSet = new Set(existing.map((row) => row.id));
    if (!stageIds.every((id) => existingIdSet.has(id))) {
      return c.json({ error: 'Invalid stageIds for this account' }, 400);
    }

    await Promise.all(
      stageIds.map((stageId, orderIndex) =>
        db.update(accountStageTemplates)
          .set({ orderIndex })
          .where(and(eq(accountStageTemplates.id, stageId), eq(accountStageTemplates.accountId, accountId))),
      ),
    );

    const templates = await db
      .select()
      .from(accountStageTemplates)
      .where(eq(accountStageTemplates.accountId, accountId))
      .orderBy(accountStageTemplates.orderIndex);

    return c.json({ data: templates });
  } catch {
    return c.json({ error: 'Failed to reorder stage templates' }, 500);
  }
});

/* POST /accounts/:id/stage-templates/apply-to-jobs */
accountsRouter.post('/:id/stage-templates/apply-to-jobs', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const role = c.get('userRole') as UserRole | null;
    const accountId = parseInt(c.req.param('id'));
    if (isNaN(accountId)) return c.json({ error: 'Invalid account id' }, 400);
    if (!canWriteStageTemplates(role)) return stageWriteForbidden(c);

    const account = await getAccountIfAccessible(accountId, userId, orgId);
    if (!account) return c.json({ error: 'Account not found or unauthorized' }, 403);

    const result = await applyTemplatesToAccountJobsWithoutStages(accountId);
    return c.json({
      message: 'Templates applied to jobs without stages',
      ...result,
    });
  } catch {
    return c.json({ error: 'Failed to apply templates to jobs' }, 500);
  }
});

/* GET /accounts */
accountsRouter.get('/', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const view = c.req.query('view') ?? 'all';
    const typeFilter = c.req.query('type');
    const statusFilter = c.req.query('status');
    const search = c.req.query('search')?.trim().toLowerCase() ?? '';
    const { page, pageSize } = parsePagination(c.req.query());

    let rows = await listAccountsSafe(orgId, userId);

    if (view === 'mine') rows = rows.filter((r) => r.createdBy === userId);
    if (view === 'recent') {
      const cutoff = new Date(Date.now() - RECENT_DAYS * MS_PER_DAY).toISOString();
      rows = rows.filter((r) => r.createdAt >= cutoff);
    }
    if (typeFilter && typeFilter !== 'all') rows = rows.filter((r) => r.type === typeFilter);
    if (statusFilter && statusFilter !== 'all') rows = rows.filter((r) => r.status === statusFilter);

    const enriched = await Promise.all(rows.map(enrichAccount));

    const filtered = search
      ? enriched.filter((a) => {
          const blob = `${a.name} ${a.website} ${a.typeLabel} ${a.city} ${a.country}`.toLowerCase();
          return blob.includes(search);
        })
      : enriched;

    return c.json(paginateInMemory(filtered, page, pageSize));
  } catch {
    return c.json({ error: 'Failed to fetch accounts' }, 500);
  }
});

/* POST /accounts/merge — must be before /:id */
accountsRouter.post('/merge', requireAuth, requireRole('recruiter_admin'), zValidator('json', mergeSchema), async (c) => {
  try {
    const { targetId, sourceIds } = c.req.valid('json');
    const sources = sourceIds.filter((id) => id !== targetId);
    if (sources.length === 0) return c.json({ error: 'No source accounts to merge' }, 400);

    for (const sid of sources) {
      await db.update(contacts).set({ accountId: targetId }).where(eq(contacts.accountId, sid));
      await db.delete(accounts).where(eq(accounts.id, sid));
    }

    const [target] = await getAccountByIdSafe(targetId);
    if (!target) return c.json({ error: 'Target account not found' }, 404);
    return c.json(await enrichAccount(target));
  } catch {
    return c.json({ error: 'Failed to merge accounts' }, 500);
  }
});

/* GET /accounts/:id/delete-preview — must be before /:id */
accountsRouter.get('/:id/delete-preview', requireAuth, requireRole('recruiter_admin'), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const [account] = await getAccountByIdSafe(id);
    if (!account) return c.json({ error: 'Account not found' }, 404);
    if (!belongsToOrganization(account.organizationId, orgId, account.createdBy, userId)) {
      return c.json({ error: 'Account not found' }, 404);
    }

    return c.json(await getAccountDeletePreview(id));
  } catch {
    return c.json({ error: 'Failed to fetch delete preview' }, 500);
  }
});

/* GET /accounts/:id/stats — must be before /:id */
accountsRouter.get('/:id/stats', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const [account] = await getAccountByIdSafe(id);
    if (!account) return c.json({ error: 'Account not found' }, 404);

    if (!belongsToOrganization(account.organizationId, orgId, account.createdBy, userId)) {
      return c.json({ error: 'Account not found' }, 404);
    }

    const accountJobs = await db.select().from(jobs).where(eq(jobs.accountId, id));
    const totalJobs = accountJobs.length;
    const activeJobs = accountJobs.filter(
      (j) => j.status === 'submission_in_progress' || j.status === 'ready',
    ).length;

    const [contactRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(contacts)
      .where(eq(contacts.accountId, id));

    const [activeContactRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(contacts)
      .where(and(eq(contacts.accountId, id), eq(contacts.status, 'active')));

    return c.json({
      accountId: id,
      totalJobs,
      activeJobs,
      totalContacts: Number(contactRow?.count ?? 0),
      activeContacts: Number(activeContactRow?.count ?? 0),
    });
  } catch {
    return c.json({ error: 'Failed to fetch account stats' }, 500);
  }
});

/* GET /accounts/:id */
accountsRouter.get('/:id', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    const row = await getAccountByIdSafe(id);
    if (!row.length) return c.json({ error: 'Account not found' }, 404);

    if (!belongsToOrganization(row[0].organizationId, orgId, row[0].createdBy, userId)) {
      return c.json({ error: 'Account not found' }, 404);
    }

    return c.json(await enrichAccount(row[0]));
  } catch {
    return c.json({ error: 'Failed to fetch account' }, 500);
  }
});

/* POST /accounts */
accountsRouter.post('/', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), zValidator('json', accountBody), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const b = c.req.valid('json');
    const now = new Date().toISOString();

    let created: typeof accounts.$inferSelect | undefined;
    try {
      const [row] = await db.insert(accounts).values({
        name: b.name,
        status: b.status ?? 'active',
        type: b.type ?? 'client',
        contractValue: b.contractValue ?? 0,
        tags: JSON.stringify(b.tags ?? []),
        alertsEnabled: b.alertsEnabled ? 1 : 0,
        website: b.website ?? '',
        description: b.description ?? '',
        phone: b.phone ?? '',
        email: b.email ?? '',
        address: b.address ?? '',
        city: b.city ?? '',
        state: b.state ?? '',
        country: b.country ?? '',
        organizationId: orgId,
        createdBy: userId,
        updatedAt: now,
      }).returning();
      created = row;
    } catch (error) {
      if (!isAccountsSchemaDriftError(error)) throw error;
      const [row] = await db.insert(accounts).values({
        name: b.name,
        status: b.status ?? 'active',
        type: b.type ?? 'client',
        website: b.website ?? '',
        description: b.description ?? '',
        phone: b.phone ?? '',
        email: b.email ?? '',
        address: b.address ?? '',
        city: b.city ?? '',
        state: b.state ?? '',
        country: b.country ?? '',
        organizationId: orgId,
        createdBy: userId,
        updatedAt: now,
      }).returning();
      created = { ...row, contractValue: 0, tags: '[]', alertsEnabled: 0 } as typeof accounts.$inferSelect;
    }

    return c.json(await enrichAccount(created), 201);
  } catch {
    return c.json({ error: 'Failed to create account' }, 500);
  }
});

/* PUT /accounts/:id */
accountsRouter.put('/:id', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), zValidator('json', accountBody.partial()), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const [existing] = await getAccountByIdSafe(id);
    if (!existing) return c.json({ error: 'Account not found' }, 404);
    if (!belongsToOrganization(existing.organizationId, orgId, existing.createdBy, userId)) {
      return c.json({ error: 'Account not found' }, 404);
    }

    const b = c.req.valid('json');
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const k of ['name','status','type','contractValue','website','description','phone','email','address','city','state','country','shortLogoUrl','longLogoUrl'] as const) {
      if (b[k] !== undefined) patch[k] = b[k];
    }
    if (b.tags !== undefined) patch.tags = JSON.stringify(b.tags);
    if (b.alertsEnabled !== undefined) patch.alertsEnabled = b.alertsEnabled ? 1 : 0;

    let updated: typeof accounts.$inferSelect | undefined;
    try {
      const [row] = await db.update(accounts).set(patch as any).where(eq(accounts.id, id)).returning();
      updated = row;
    } catch (error) {
      if (!isAccountsSchemaDriftError(error)) throw error;
      delete patch.contractValue;
      delete patch.tags;
      delete patch.alertsEnabled;
      const [row] = await db.update(accounts).set(patch as any).where(eq(accounts.id, id)).returning();
      updated = { ...row, contractValue: 0, tags: '[]', alertsEnabled: 0 } as typeof accounts.$inferSelect;
    }
    if (!updated) return c.json({ error: 'Account not found' }, 404);
    return c.json(await enrichAccount(updated));
  } catch {
    return c.json({ error: 'Failed to update account' }, 500);
  }
});

/* DELETE /accounts/:id */
accountsRouter.delete('/:id', requireAuth, requireRole('recruiter_admin'), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const [existing] = await getAccountByIdSafe(id);
    if (!existing) return c.json({ error: 'Account not found' }, 404);
    if (!belongsToOrganization(existing.organizationId, orgId, existing.createdBy, userId)) {
      return c.json({ error: 'Account not found' }, 404);
    }

    await cascadeDeleteAccount(id);
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'Failed to delete account' }, 500);
  }
});

export default accountsRouter;
