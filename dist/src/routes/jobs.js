import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import { jobs } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { requireAuth } from '../middleware.js';
const jobsRouter = new Hono({ strict: false });
const jobSchema = z.object({
    title: z.string().min(1, "Title is required"),
    department: z.string().optional(),
    status: z.enum(["Active", "Draft", "Closed"]).optional(),
    type: z.enum(["Full-time", "Part-time", "Contract"]).optional(),
    location: z.enum(["Remote", "On-site", "Hybrid"]).optional(),
    description: z.string().optional(),
});
// GET /jobs — list all, newest first
jobsRouter.get('/', requireAuth, async (c) => {
    try {
        const userId = c.get('userId');
        const all = await db
            .select()
            .from(jobs)
            .where(eq(jobs.createdBy, userId))
            .orderBy(desc(jobs.id));
        const now = Date.now();
        const result = all.map((j) => ({
            ...j,
            skills: j.description,
            postedDate: formatRelativeTime(j.postedDate, now),
        }));
        return c.json(result);
    }
    catch (error) {
        return c.json({ error: 'Failed to fetch jobs' }, 500);
    }
});
// POST /jobs — create
jobsRouter.post('/', requireAuth, zValidator('json', jobSchema), async (c) => {
    try {
        const userId = c.get('userId');
        const body = c.req.valid('json');
        const { title, department, status, type, location, description } = body;
        const created = await db.insert(jobs).values({
            title,
            department: department || 'General',
            status: status || 'Active',
            type: type || 'Full-time',
            location: location || 'Remote',
            description: description || '',
            applicants: 0,
            createdBy: userId,
        }).returning();
        return c.json(created[0], 201);
    }
    catch (error) {
        return c.json({ error: 'Failed to create job' }, 500);
    }
});
// PUT /jobs/:id — update
jobsRouter.put('/:id', requireAuth, zValidator('json', jobSchema), async (c) => {
    try {
        const userId = c.get('userId');
        const id = parseInt(c.req.param('id'));
        const body = c.req.valid('json');
        // Make sure they own it
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
    catch (error) {
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
    catch (error) {
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
