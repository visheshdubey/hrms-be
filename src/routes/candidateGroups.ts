import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import { candidateGroups, candidateGroupMembers, candidates } from '../db/schema.js';
import { eq, and, sql } from 'drizzle-orm';
import { requireAuth, requireRecruiter, type AppContext } from '../middleware.js';

const candidateGroupsRouter = new Hono<AppContext>({ strict: false });

const groupBody = z.object({
  name: z.string().min(1, 'Group name is required'),
  description: z.string().optional(),
});

const membersBody = z.object({
  candidateIds: z.array(z.number().int().positive()).min(1),
});

async function enrichGroup(row: typeof candidateGroups.$inferSelect) {
  const [countRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(candidateGroupMembers)
    .where(eq(candidateGroupMembers.groupId, row.id));

  return {
    ...row,
    memberCount: Number(countRow?.count ?? 0),
  };
}

/* GET /candidate-groups */
candidateGroupsRouter.get('/', requireAuth, requireRecruiter, async (c) => {
  try {
    const orgId = c.get('organizationId') as number | null;
    if (!orgId) return c.json({ data: [] });

    const rows = await db.select().from(candidateGroups).where(eq(candidateGroups.organizationId, orgId));
    const data = await Promise.all(rows.map(enrichGroup));
    return c.json({ data });
  } catch {
    return c.json({ error: 'Failed to fetch candidate groups' }, 500);
  }
});

/* GET /candidate-groups/:id */
candidateGroupsRouter.get('/:id', requireAuth, requireRecruiter, async (c) => {
  try {
    const orgId = c.get('organizationId') as number | null;
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const [row] = await db.select().from(candidateGroups)
      .where(and(eq(candidateGroups.id, id), eq(candidateGroups.organizationId, orgId!))).limit(1);
    if (!row) return c.json({ error: 'Group not found' }, 404);

    const members = await db
      .select({
        id: candidates.id,
        name: candidates.name,
        email: candidates.email,
      })
      .from(candidateGroupMembers)
      .innerJoin(candidates, eq(candidateGroupMembers.candidateId, candidates.id))
      .where(eq(candidateGroupMembers.groupId, id));

    return c.json({ ...await enrichGroup(row), members });
  } catch {
    return c.json({ error: 'Failed to fetch candidate group' }, 500);
  }
});

/* POST /candidate-groups */
candidateGroupsRouter.post('/', requireAuth, requireRecruiter, zValidator('json', groupBody), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    if (!orgId) return c.json({ error: 'No organization' }, 404);

    const b = c.req.valid('json');
    const [created] = await db.insert(candidateGroups).values({
      organizationId: orgId,
      name: b.name,
      description: b.description ?? '',
      createdBy: userId,
    }).returning();

    return c.json(await enrichGroup(created), 201);
  } catch {
    return c.json({ error: 'Failed to create candidate group' }, 500);
  }
});

/* PUT /candidate-groups/:id */
candidateGroupsRouter.put('/:id', requireAuth, requireRecruiter, zValidator('json', groupBody.partial()), async (c) => {
  try {
    const orgId = c.get('organizationId') as number | null;
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const [existing] = await db.select().from(candidateGroups)
      .where(and(eq(candidateGroups.id, id), eq(candidateGroups.organizationId, orgId!))).limit(1);
    if (!existing) return c.json({ error: 'Group not found' }, 404);

    const b = c.req.valid('json');
    const patch: Record<string, unknown> = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.description !== undefined) patch.description = b.description;

    const [updated] = await db.update(candidateGroups).set(patch as typeof candidateGroups.$inferInsert)
      .where(eq(candidateGroups.id, id)).returning();
    return c.json(await enrichGroup(updated));
  } catch {
    return c.json({ error: 'Failed to update candidate group' }, 500);
  }
});

/* DELETE /candidate-groups/:id */
candidateGroupsRouter.delete('/:id', requireAuth, requireRecruiter, async (c) => {
  try {
    const orgId = c.get('organizationId') as number | null;
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const [existing] = await db.select().from(candidateGroups)
      .where(and(eq(candidateGroups.id, id), eq(candidateGroups.organizationId, orgId!))).limit(1);
    if (!existing) return c.json({ error: 'Group not found' }, 404);

    await db.delete(candidateGroupMembers).where(eq(candidateGroupMembers.groupId, id));
    await db.delete(candidateGroups).where(eq(candidateGroups.id, id));
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'Failed to delete candidate group' }, 500);
  }
});

/* POST /candidate-groups/:id/members */
candidateGroupsRouter.post('/:id/members', requireAuth, requireRecruiter, zValidator('json', membersBody), async (c) => {
  try {
    const orgId = c.get('organizationId') as number | null;
    const groupId = parseInt(c.req.param('id'));
    if (isNaN(groupId)) return c.json({ error: 'Invalid id' }, 400);

    const [existing] = await db.select().from(candidateGroups)
      .where(and(eq(candidateGroups.id, groupId), eq(candidateGroups.organizationId, orgId!))).limit(1);
    if (!existing) return c.json({ error: 'Group not found' }, 404);

    const { candidateIds } = c.req.valid('json');
    for (const candidateId of candidateIds) {
      await db.insert(candidateGroupMembers).values({ groupId, candidateId }).onConflictDoNothing();
    }

    return c.json({ ok: true, added: candidateIds.length });
  } catch {
    return c.json({ error: 'Failed to add members' }, 500);
  }
});

/* DELETE /candidate-groups/:id/members/:candidateId */
candidateGroupsRouter.delete('/:id/members/:candidateId', requireAuth, requireRecruiter, async (c) => {
  try {
    const groupId = parseInt(c.req.param('id'));
    const candidateId = parseInt(c.req.param('candidateId'));
    if (isNaN(groupId) || isNaN(candidateId)) return c.json({ error: 'Invalid id' }, 400);

    await db.delete(candidateGroupMembers).where(
      and(eq(candidateGroupMembers.groupId, groupId), eq(candidateGroupMembers.candidateId, candidateId)),
    );
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'Failed to remove member' }, 500);
  }
});

export default candidateGroupsRouter;
