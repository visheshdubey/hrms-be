import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import { jobs, users } from '../db/schema.js';
import { eq, desc, inArray } from 'drizzle-orm';
import { requireAuth } from '../middleware.js';
const jobsRouter = new Hono({ strict: false });
/** Allowed forward/backward transitions per the Phase 2 lifecycle spec */
const TRANSITIONS = {
    new: ['draft'],
    draft: ['ready'],
    ready: ['draft', 'submission_in_progress'],
    submission_in_progress: ['closed'],
    closed: [],
};
const jobSchema = z.object({
    title: z.string().min(1, "Title is required"),
    department: z.string().optional(),
    status: z.enum(["new", "draft", "ready", "submission_in_progress", "closed"]).optional(),
    type: z.enum(["Full-time", "Part-time", "Contract"]).optional(),
    location: z.enum(["Remote", "On-site", "Hybrid"]).optional(),
    description: z.string().optional(),
});
const statusSchema = z.object({
    status: z.enum(["new", "draft", "ready", "submission_in_progress", "closed"]),
});
// GET /jobs — list all jobs visible to the authenticated user's organization
jobsRouter.get('/', requireAuth, async (c) => {
    try {
        const userId = c.get('userId');
        const orgId = c.get('organizationId');
        let all;
        if (orgId != null) {
            const orgMembers = await db
                .select({ id: users.id })
                .from(users)
                .where(eq(users.organizationId, orgId));
            const memberIds = orgMembers.map((u) => u.id);
            if (memberIds.length === 0)
                return c.json([]);
            all = await db
                .select()
                .from(jobs)
                .where(inArray(jobs.createdBy, memberIds))
                .orderBy(desc(jobs.id));
        }
        else {
            all = await db
                .select()
                .from(jobs)
                .where(eq(jobs.createdBy, userId))
                .orderBy(desc(jobs.id));
        }
        const now = Date.now();
        const result = all.map((j) => ({
            ...j,
            skills: j.description,
            postedDate: formatRelativeTime(j.postedDate, now),
        }));
        return c.json(result);
    }
    catch {
        return c.json({ error: 'Failed to fetch jobs' }, 500);
    }
});
// GET /jobs/:id — single job detail
jobsRouter.get('/:id', requireAuth, async (c) => {
    try {
        const id = parseInt(c.req.param('id'));
        if (isNaN(id))
            return c.json({ error: 'Invalid id' }, 400);
        const row = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
        if (row.length === 0)
            return c.json({ error: 'Job not found' }, 404);
        const j = row[0];
        return c.json({
            ...j,
            skills: j.description,
            postedDate: formatRelativeTime(j.postedDate, Date.now()),
            allowedTransitions: TRANSITIONS[j.status] ?? [],
        });
    }
    catch {
        return c.json({ error: 'Failed to fetch job' }, 500);
    }
});
// POST /jobs — create (defaults to 'new')
jobsRouter.post('/', requireAuth, zValidator('json', jobSchema), async (c) => {
    try {
        const userId = c.get('userId');
        const body = c.req.valid('json');
        const { title, department, status, type, location, description } = body;
        const created = await db.insert(jobs).values({
            title,
            department: department || 'General',
            status: status || 'new',
            type: type || 'Full-time',
            location: location || 'Remote',
            description: description || '',
            applicants: 0,
            createdBy: userId,
        }).returning();
        return c.json(created[0], 201);
    }
    catch {
        return c.json({ error: 'Failed to create job' }, 500);
    }
});
// PATCH /jobs/:id/status — explicit lifecycle transition
jobsRouter.patch('/:id/status', requireAuth, zValidator('json', statusSchema), async (c) => {
    try {
        const orgId = c.get('organizationId');
        const userId = c.get('userId');
        const id = parseInt(c.req.param('id'));
        if (isNaN(id))
            return c.json({ error: 'Invalid id' }, 400);
        const { status: nextStatus } = c.req.valid('json');
        const row = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1);
        if (row.length === 0)
            return c.json({ error: 'Job not found' }, 404);
        // Org-scope check: the job must belong to the caller's org (or be their own)
        if (orgId != null) {
            const orgMembers = await db
                .select({ id: users.id })
                .from(users)
                .where(eq(users.organizationId, orgId));
            const memberIds = orgMembers.map((u) => u.id);
            if (!memberIds.includes(row[0].createdBy)) {
                return c.json({ error: 'Job not found or unauthorized' }, 403);
            }
        }
        else if (row[0].createdBy !== userId) {
            return c.json({ error: 'Job not found or unauthorized' }, 403);
        }
        const currentStatus = row[0].status;
        const allowed = TRANSITIONS[currentStatus] ?? [];
        if (!allowed.includes(nextStatus)) {
            return c.json({
                error: `Invalid transition: ${currentStatus} → ${nextStatus}`,
                allowedTransitions: allowed,
            }, 400);
        }
        const updated = await db.update(jobs)
            .set({ status: nextStatus })
            .where(eq(jobs.id, id))
            .returning();
        return c.json({
            ...updated[0],
            allowedTransitions: TRANSITIONS[nextStatus] ?? [],
        });
    }
    catch {
        return c.json({ error: 'Failed to update job status' }, 500);
    }
});
// PUT /jobs/:id — full update
jobsRouter.put('/:id', requireAuth, zValidator('json', jobSchema), async (c) => {
    try {
        const userId = c.get('userId');
        const id = parseInt(c.req.param('id'));
        const body = c.req.valid('json');
        const existing = await db.select().from(jobs).where(eq(jobs.id, id));
        if (existing.length === 0 || existing[0].createdBy !== userId) {
            return c.json({ error: 'Job not found or unauthorized' }, 403);
        }
        const updated = await db.update(jobs)
            .set({
            title: body.title,
            department: body.department,
            status: body.status,
            type: body.type,
            location: body.location,
            description: body.description,
        })
            .where(eq(jobs.id, id))
            .returning();
        if (updated.length === 0)
            return c.json({ error: 'Job not found' }, 404);
        return c.json(updated[0]);
    }
    catch {
        return c.json({ error: 'Failed to update job' }, 500);
    }
});
// DELETE /jobs/:id
jobsRouter.delete('/:id', requireAuth, async (c) => {
    try {
        const userId = c.get('userId');
        const id = parseInt(c.req.param('id'));
        const existing = await db.select().from(jobs).where(eq(jobs.id, id));
        if (existing.length === 0 || existing[0].createdBy !== userId) {
            return c.json({ error: 'Job not found or unauthorized' }, 403);
        }
        await db.delete(jobs).where(eq(jobs.id, id));
        return c.json({ message: 'Job deleted' });
    }
    catch {
        return c.json({ error: 'Failed to delete job' }, 500);
    }
});
function formatRelativeTime(dateStr, now) {
    if (!dateStr)
        return 'Just now';
    const diff = now - new Date(dateStr).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1)
        return 'Just now';
    if (minutes < 60)
        return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days !== 1 ? 's' : ''} ago`;
}
export default jobsRouter;
