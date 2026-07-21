import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import { applications, tags, candidateTags, applicationTags, candidates, users } from '../db/schema.js';
import { eq, and, inArray } from 'drizzle-orm';
import { requireAuth, requireRecruiter, type AppContext } from '../middleware.js';

const tagsRouter = new Hono<AppContext>({ strict: false });

const tagBody = z.object({
  name: z.string().min(1, 'Tag name is required'),
  color: z.string().optional(),
});

const memberBody = z.object({
  candidateIds: z.array(z.number().int().positive()).optional(),
  applicationIds: z.array(z.number().int().positive()).optional(),
});

function requireOrgId(c: { get: (key: string) => unknown }) {
  const orgId = c.get('organizationId') as number | null;
  if (!orgId) return null;
  return orgId;
}

/* GET /settings/tags */
tagsRouter.get('/', requireAuth, requireRecruiter, async (c) => {
  try {
    const orgId = requireOrgId(c);
    if (!orgId) return c.json({ data: [] });

    const rows = await db.select().from(tags).where(eq(tags.organizationId, orgId));
    return c.json({ data: rows });
  } catch {
    return c.json({ error: 'Failed to fetch tags' }, 500);
  }
});

/* POST /settings/tags */
tagsRouter.post('/', requireAuth, requireRecruiter, zValidator('json', tagBody), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = requireOrgId(c);
    if (!orgId) return c.json({ error: 'No organization' }, 404);

    const b = c.req.valid('json');
    const [created] = await db.insert(tags).values({
      organizationId: orgId,
      name: b.name,
      color: b.color ?? '#6366f1',
      createdBy: userId,
    }).returning();

    return c.json(created, 201);
  } catch {
    return c.json({ error: 'Failed to create tag' }, 500);
  }
});

/* PUT /settings/tags/:id */
tagsRouter.put('/:id', requireAuth, requireRecruiter, zValidator('json', tagBody.partial()), async (c) => {
  try {
    const orgId = requireOrgId(c);
    if (!orgId) return c.json({ error: 'No organization' }, 404);

    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const [existing] = await db.select().from(tags)
      .where(and(eq(tags.id, id), eq(tags.organizationId, orgId))).limit(1);
    if (!existing) return c.json({ error: 'Tag not found' }, 404);

    const b = c.req.valid('json');
    const patch: Record<string, unknown> = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.color !== undefined) patch.color = b.color;

    const [updated] = await db.update(tags).set(patch as typeof tags.$inferInsert)
      .where(eq(tags.id, id)).returning();
    return c.json(updated);
  } catch {
    return c.json({ error: 'Failed to update tag' }, 500);
  }
});

/* DELETE /settings/tags/:id */
tagsRouter.delete('/:id', requireAuth, requireRecruiter, async (c) => {
  try {
    const orgId = requireOrgId(c);
    if (!orgId) return c.json({ error: 'No organization' }, 404);

    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const [existing] = await db.select().from(tags)
      .where(and(eq(tags.id, id), eq(tags.organizationId, orgId))).limit(1);
    if (!existing) return c.json({ error: 'Tag not found' }, 404);

    await db.delete(candidateTags).where(eq(candidateTags.tagId, id));
    await db.delete(applicationTags).where(eq(applicationTags.tagId, id));
    await db.delete(tags).where(eq(tags.id, id));
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'Failed to delete tag' }, 500);
  }
});

/* POST /settings/tags/:id/members — attach to candidates and/or applications */
tagsRouter.post('/:id/members', requireAuth, requireRecruiter, zValidator('json', memberBody), async (c) => {
  try {
    const orgId = requireOrgId(c);
    if (!orgId) return c.json({ error: 'No organization' }, 404);

    const tagId = parseInt(c.req.param('id'));
    if (isNaN(tagId)) return c.json({ error: 'Invalid id' }, 400);

    const [existing] = await db.select().from(tags)
      .where(and(eq(tags.id, tagId), eq(tags.organizationId, orgId))).limit(1);
    if (!existing) return c.json({ error: 'Tag not found' }, 404);

    const body = c.req.valid('json');
    const candidateIds = [...new Set(body.candidateIds ?? [])];
    const applicationIds = [...new Set(body.applicationIds ?? [])];

    if (candidateIds.length > 0) {
      const accessibleCandidates = await db
        .select({ id: candidates.id })
        .from(candidates)
        .innerJoin(users, eq(candidates.createdBy, users.id))
        .where(and(inArray(candidates.id, candidateIds), eq(users.organizationId, orgId)));
      if (accessibleCandidates.length !== candidateIds.length) {
        return c.json({ error: 'One or more candidates were not found' }, 404);
      }
    }

    if (applicationIds.length > 0) {
      const accessibleApplications = await db
        .select({ id: applications.id })
        .from(applications)
        .innerJoin(candidates, eq(applications.candidateId, candidates.id))
        .innerJoin(users, eq(candidates.createdBy, users.id))
        .where(and(inArray(applications.id, applicationIds), eq(users.organizationId, orgId)));
      if (accessibleApplications.length !== applicationIds.length) {
        return c.json({ error: 'One or more applications were not found' }, 404);
      }
    }

    for (const candidateId of candidateIds) {
      await db.insert(candidateTags).values({ candidateId, tagId }).onConflictDoNothing();
    }
    for (const applicationId of applicationIds) {
      await db.insert(applicationTags).values({ applicationId, tagId }).onConflictDoNothing();
    }

    return c.json({ ok: true, candidateIds, applicationIds });
  } catch {
    return c.json({ error: 'Failed to attach tag' }, 500);
  }
});

/* DELETE /settings/tags/:id/candidates/:candidateId */
tagsRouter.delete('/:id/candidates/:candidateId', requireAuth, requireRecruiter, async (c) => {
  try {
    const orgId = requireOrgId(c);
    if (!orgId) return c.json({ error: 'No organization' }, 404);

    const tagId = parseInt(c.req.param('id'));
    const candidateId = parseInt(c.req.param('candidateId'));
    if (isNaN(tagId) || isNaN(candidateId)) return c.json({ error: 'Invalid id' }, 400);

    const [membership] = await db
      .select({ tagId: candidateTags.tagId })
      .from(candidateTags)
      .innerJoin(tags, eq(candidateTags.tagId, tags.id))
      .innerJoin(candidates, eq(candidateTags.candidateId, candidates.id))
      .innerJoin(users, eq(candidates.createdBy, users.id))
      .where(and(
        eq(candidateTags.tagId, tagId),
        eq(candidateTags.candidateId, candidateId),
        eq(tags.organizationId, orgId),
        eq(users.organizationId, orgId),
      ))
      .limit(1);
    if (!membership) return c.json({ error: 'Tag assignment not found' }, 404);

    await db.delete(candidateTags).where(
      and(eq(candidateTags.tagId, tagId), eq(candidateTags.candidateId, candidateId)),
    );
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'Failed to detach tag' }, 500);
  }
});

export default tagsRouter;
