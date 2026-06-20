import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import { contacts, accounts, users, CONTACT_STATUSES } from '../db/schema.js';
import { eq, desc, inArray } from 'drizzle-orm';
import { requireAuth, requireRole, type AppContext } from '../middleware.js';

const contactsRouter = new Hono<AppContext>({ strict: false });

type ConStatus = typeof CONTACT_STATUSES[number];

const STATUS_LABELS: Record<ConStatus, string> = {
  active: 'Active', inactive: 'Inactive',
};

async function orgMemberIds(orgId: number | null, userId: number): Promise<number[]> {
  if (orgId == null) return [userId];
  const members = await db.select({ id: users.id }).from(users).where(eq(users.organizationId, orgId));
  return members.map((m) => m.id);
}

async function enrichContact(row: typeof contacts.$inferSelect) {
  const [acc] = await db.select({
    id: accounts.id, name: accounts.name, type: accounts.type, website: accounts.website,
  }).from(accounts).where(eq(accounts.id, row.accountId));

  let ownerName = '';
  if (row.createdBy) {
    const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, row.createdBy));
    ownerName = u?.name ?? '';
  }

  return {
    ...row,
    fullName: `${row.firstName} ${row.lastName}`.trim(),
    account: acc ?? null,
    ownerName,
    statusLabel: STATUS_LABELS[row.status as ConStatus] ?? row.status,
  };
}

const contactBody = z.object({
  accountId: z.number().int().positive(),
  firstName: z.string().min(1, 'First name is required'),
  lastName: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  jobTitle: z.string().optional(),
  department: z.string().optional(),
  status: z.enum(CONTACT_STATUSES).optional(),
  linkedin: z.string().optional(),
});

/* GET /contacts */
contactsRouter.get('/', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const view = c.req.query('view') ?? 'all';
    const accountId = c.req.query('accountId');
    const search = c.req.query('search')?.trim().toLowerCase() ?? '';
    const page = Math.max(1, parseInt(c.req.query('page') ?? '1') || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(c.req.query('pageSize') ?? '20') || 20));

    const memberIds = await orgMemberIds(orgId, userId);
    if (memberIds.length === 0) return c.json({ data: [], total: 0, page, pageSize });

    let rows = await db.select().from(contacts)
      .where(inArray(contacts.createdBy, memberIds))
      .orderBy(desc(contacts.updatedAt));

    if (view === 'mine') rows = rows.filter((r) => r.createdBy === userId);
    if (view === 'recent') {
      const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
      rows = rows.filter((r) => r.createdAt >= cutoff);
    }
    if (accountId) {
      const aid = parseInt(accountId);
      if (!isNaN(aid)) rows = rows.filter((r) => r.accountId === aid);
    }

    const enriched = await Promise.all(rows.map(enrichContact));

    const filtered = search
      ? enriched.filter((ct) => {
          const blob = `${ct.fullName} ${ct.email} ${ct.jobTitle} ${ct.account?.name}`.toLowerCase();
          return blob.includes(search);
        })
      : enriched;

    const total = filtered.length;
    const start = (page - 1) * pageSize;
    return c.json({ data: filtered.slice(start, start + pageSize), total, page, pageSize });
  } catch {
    return c.json({ error: 'Failed to fetch contacts' }, 500);
  }
});

/* GET /contacts/:id */
contactsRouter.get('/:id', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    const row = await db.select().from(contacts).where(eq(contacts.id, id)).limit(1);
    if (!row.length) return c.json({ error: 'Contact not found' }, 404);
    return c.json(await enrichContact(row[0]));
  } catch {
    return c.json({ error: 'Failed to fetch contact' }, 404);
  }
});

/* POST /contacts */
contactsRouter.post('/', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), zValidator('json', contactBody), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const b = c.req.valid('json');
    const now = new Date().toISOString();

    const [acc] = await db.select().from(accounts).where(eq(accounts.id, b.accountId)).limit(1);
    if (!acc) return c.json({ error: 'Account not found' }, 404);

    const [created] = await db.insert(contacts).values({
      accountId: b.accountId,
      firstName: b.firstName,
      lastName: b.lastName ?? '',
      email: b.email ?? '',
      phone: b.phone ?? '',
      jobTitle: b.jobTitle ?? '',
      department: b.department ?? '',
      status: b.status ?? 'active',
      linkedin: b.linkedin ?? '',
      organizationId: orgId,
      createdBy: userId,
      updatedAt: now,
    }).returning();

    return c.json(await enrichContact(created), 201);
  } catch {
    return c.json({ error: 'Failed to create contact' }, 500);
  }
});

/* PUT /contacts/:id */
contactsRouter.put('/:id', requireAuth, requireRole('recruiter_admin', 'recruited_staff'), zValidator('json', contactBody.partial()), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    const b = c.req.valid('json');
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const k of ['accountId','firstName','lastName','email','phone','jobTitle','department','status','linkedin'] as const) {
      if (b[k] !== undefined) patch[k] = b[k];
    }

    const [updated] = await db.update(contacts).set(patch as any).where(eq(contacts.id, id)).returning();
    if (!updated) return c.json({ error: 'Contact not found' }, 404);
    return c.json(await enrichContact(updated));
  } catch {
    return c.json({ error: 'Failed to update contact' }, 500);
  }
});

/* DELETE /contacts/:id */
contactsRouter.delete('/:id', requireAuth, requireRole('recruiter_admin'), async (c) => {
  try {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);
    await db.delete(contacts).where(eq(contacts.id, id));
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'Failed to delete contact' }, 500);
  }
});

export default contactsRouter;
