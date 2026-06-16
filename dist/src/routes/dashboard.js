import { Hono } from 'hono';
import { db } from '../db/index.js';
import { jobs, candidates } from '../db/schema.js';
import { eq, desc, and } from 'drizzle-orm';
import { requireAuth } from '../middleware.js';
const dashboardRouter = new Hono({ strict: false });
dashboardRouter.get('/', requireAuth, async (c) => {
    try {
        const userId = c.get('userId');
        // Total candidates
        const allCandidates = await db.select().from(candidates).where(eq(candidates.createdBy, userId));
        const totalCandidates = allCandidates.length;
        // Active jobs
        const activeJobsQuery = await db.select().from(jobs).where(and(eq(jobs.status, 'Active'), eq(jobs.createdBy, userId)));
        const activeJobs = activeJobsQuery.length;
        // Recent uploads (Top 5)
        const recentUploads = await db
            .select({
            id: candidates.id,
            name: candidates.name,
            filename: candidates.filename,
            matchScore: candidates.matchScore,
            createdAt: candidates.createdAt,
        })
            .from(candidates)
            .where(eq(candidates.createdBy, userId))
            .orderBy(desc(candidates.createdAt))
            .limit(5);
        return c.json({
            totalCandidates,
            activeJobs,
            recentUploads,
        });
    }
    catch (error) {
        console.error("Dashboard error:", error);
        return c.json({ error: 'Failed to fetch dashboard metrics' }, 500);
    }
});
export default dashboardRouter;
