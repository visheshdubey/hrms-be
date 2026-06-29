import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import { accounts, contacts, users, jobs, ACCOUNT_STATUSES, ACCOUNT_TYPES } from '../db/schema.js';
import { eq, desc, inArray, sql, and } from 'drizzle-orm';
import { requireAuth, requireRole, type AppContext } from '../middleware.js';
import { getOrgMemberIds, isOrgMember } from '../lib/orgScope.js';
import { parsePagination, paginateInMemory } from '../lib/pagination.js';
import { MS_PER_DAY, RECENT_DAYS } from '../config.js';

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
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, row.createdBy));
    ownerName = u?.name ?? '';
  }
  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(contacts)
    .where(eq(contacts.accountId, row.id));

  return {
    ...row,
    ownerName,
    contactCount: Number(countRow?.count ?? 0),
    statusLabel: STATUS_LABELS[row.status as AccStatus] ?? row.status,
    typeLabel: TYPE_LABELS[row.type as AccType] ?? row.type,
  };
}

const accountBody = z.object({
  name: z.string().min(1, 'Account name is required'),
  status: z.enum(ACCOUNT_STATUSES).optional(),
  type: z.enum(ACCOUNT_TYPES).optional(),
  website: z.string().optional(),
  description: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
});

const mergeSchema = z.object({
  targetId: z.number().int().positive(),
  sourceIds: z.array(z.number().int().positive()).min(1),
});

/* GET /accounts */
accountsRouter.get('/', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const view = c.req.query('view') ?? 'all';
    const typeFilter = c.req.query('type');
    const search = c.req.query('search')?.trim().toLowerCase() ?? '';
    const { page, pageSize } = parsePagination(c.req.query());

    const memberIds = await getOrgMemberIds(orgId, userId);
    if (memberIds.length === 0) return c.json({ data: [], total: 0, page, pageSize });

    let rows = await db.select().from(accounts)
      .where(inArray(accounts.createdBy, memberIds))
      .orderBy(desc(accounts.updatedAt));

    if (view === 'mine') rows = rows.filter((r) => r.createdBy === userId);
    if (view === 'recent') {
      const cutoff = new Date(Date.now() - RECENT_DAYS * MS_PER_DAY).toISOString();
      rows = rows.filter((r) => r.createdAt >= cutoff);
    }
    if (typeFilter && typeFilter !== 'all') rows = rows.filter((r) => r.type === typeFilter);

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

    const [target] = await db.select().from(accounts).where(eq(accounts.id, targetId)).limit(1);
    if (!target) return c.json({ error: 'Target account not found' }, 404);
    return c.json(await enrichAccount(target));
  } catch {
    return c.json({ error: 'Failed to merge accounts' }, 500);
  }
});

/* GET /accounts/:id/stats — must be before /:id */
accountsRouter.get('/:id/stats', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const [account] = await db.select().from(accounts).where(eq(accounts.id, id)).limit(1);
    if (!account) return c.json({ error: 'Account not found' }, 404);

    const memberIds = await getOrgMemberIds(orgId, userId);
    if (!isOrgMember(account.createdBy, memberIds)) {
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
    const row = await db.select().from(accounts).where(eq(accounts.id, id)).limit(1);
    if (!row.length) return c.json({ error: 'Account not found' }, 404);

    const memberIds = await getOrgMemberIds(orgId, userId);
    if (!isOrgMember(row[0].createdBy, memberIds)) {
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

    const [created] = await db.insert(accounts).values({
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

    return c.json(await enrichAccount(created), 201);
  } catch {
    return c.json({ error: 'Failed to create account' }, 500);
  }
});

/* PUT /accounts/:id */
accountsRouter.put('/:id', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), zValidator('json', accountBody.partial()), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    const b = c.req.valid('json');
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const k of ['name','status','type','website','description','phone','email','address','city','state','country'] as const) {
      if (b[k] !== undefined) patch[k] = b[k];
    }

    const [updated] = await db.update(accounts).set(patch as any).where(eq(accounts.id, id)).returning();
    if (!updated) return c.json({ error: 'Account not found' }, 404);
    return c.json(await enrichAccount(updated));
  } catch {
    return c.json({ error: 'Failed to update account' }, 500);
  }
});

/* DELETE /accounts/:id */
accountsRouter.delete('/:id', requireAuth, requireRole('recruiter_admin'), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const linked = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.accountId, id)).limit(1);
    if (linked.length) return c.json({ error: 'Cannot delete account with linked contacts' }, 409);

    await db.delete(accounts).where(eq(accounts.id, id));
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'Failed to delete account' }, 500);
  }
});

export default accountsRouter;
