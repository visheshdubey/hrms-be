import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import { candidates, jobs } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';
import { requireAuth } from '../middleware.js';
const candidatesRouter = new Hono({ strict: false });
const candidateSchema = z.object({
    jobId: z.number().optional().nullable(),
    filename: z.string().optional(),
    name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    location: z.string().optional(),
    education: z.string().optional(),
    experience: z.union([z.string(), z.array(z.string())]).optional(),
    skills: z.union([z.string(), z.array(z.string())]).optional(),
    match_score: z.number().optional(),
    status: z.string().optional(),
    // New 18-layer fields
    linkedin: z.string().optional(),
    github: z.string().optional(),
    portfolio: z.string().optional(),
    certifications: z.union([z.string(), z.array(z.string())]).optional(),
    languages: z.union([z.string(), z.array(z.string())]).optional(),
    summary: z.string().optional(),
    university: z.string().optional(),
    grad_year: z.string().optional(),
    work_history: z.union([z.string(), z.array(z.any())]).optional(),
    fingerprint: z.string().optional(),
});
// GET /candidates — list all, sorted by match score DESC
candidatesRouter.get('/', requireAuth, async (c) => {
    try {
        const userId = c.get('userId');
        const all = await db
            .select()
            .from(candidates)
            .where(eq(candidates.createdBy, userId))
            .orderBy(desc(candidates.matchScore));
        const parsed = all.map((c, i) => ({
            ...c,
            skills: safeJsonParse(c.skills),
            certifications: safeJsonParse(c.certifications),
            languages: safeJsonParse(c.languages),
            workHistory: safeJsonParse(c.workHistory),
            rank: i + 1,
        }));
        return c.json(parsed);
    }
    catch {
        return c.json({ error: 'Failed to fetch candidates' }, 500);
    }
});
// POST /candidates — save a parsed candidate from ATS
candidatesRouter.post('/', requireAuth, zValidator('json', candidateSchema), async (c) => {
    try {
        const body = c.req.valid('json');
        const { jobId, filename, name, email, phone, location, education, experience, skills, match_score, status, linkedin, github, portfolio, certifications, languages, summary, university, grad_year, work_history, fingerprint, } = body;
        // Duplicate detection: check fingerprint
        if (fingerprint) {
            const userId = c.get('userId');
            const existing = await db.select()
                .from(candidates)
                .where(eq(candidates.fingerprint, fingerprint));
            const ownedDuplicate = existing.find((e) => e.createdBy === userId);
            if (ownedDuplicate) {
                return c.json({
                    warning: 'Duplicate resume detected',
                    existingId: ownedDuplicate.id,
                    existingName: ownedDuplicate.name,
                    message: `A candidate with matching details already exists (ID: ${ownedDuplicate.id}).`
                }, 409);
            }
        }
        const created = await db.insert(candidates).values({
            jobId: jobId || null,
            filename: filename || 'unknown.pdf',
            name: name || '',
            email: email || '',
            phone: phone || '',
            location: location || '',
            education: education || '',
            experience: Array.isArray(experience) ? experience[0] || 'Fresher' : (experience || ''),
            skills: JSON.stringify(Array.isArray(skills) ? skills : []),
            matchScore: match_score ?? 0,
            status: status || 'New',
            // New 18-layer fields
            linkedin: linkedin || '',
            github: github || '',
            portfolio: portfolio || '',
            certifications: JSON.stringify(Array.isArray(certifications) ? certifications : []),
            languages: JSON.stringify(Array.isArray(languages) ? languages : []),
            summary: summary || '',
            university: university || '',
            gradYear: grad_year || '',
            workHistory: JSON.stringify(Array.isArray(work_history) ? work_history : []),
            fingerprint: fingerprint || '',
            createdBy: c.get('userId'),
        }).returning();
        // Increment applicant count for the job
        if (jobId) {
            const job = await db.select().from(jobs).where(eq(jobs.id, jobId));
            if (job.length > 0) {
                await db.update(jobs)
                    .set({ applicants: job[0].applicants + 1 })
                    .where(eq(jobs.id, jobId));
            }
        }
        return c.json({
            ...created[0],
            skills: safeJsonParse(created[0].skills),
            certifications: safeJsonParse(created[0].certifications),
            languages: safeJsonParse(created[0].languages),
            workHistory: safeJsonParse(created[0].workHistory),
        }, 201);
    }
    catch (error) {
        console.error(error);
        return c.json({ error: 'Failed to save candidate' }, 500);
    }
});
// GET /candidates/csv — download CSV report for the user's candidates
candidatesRouter.get('/csv', requireAuth, async (c) => {
    try {
        const userId = c.get('userId');
        const all = await db
            .select()
            .from(candidates)
            .where(eq(candidates.createdBy, userId))
            .orderBy(desc(candidates.matchScore));
        if (all.length === 0) {
            return c.json({ error: 'No candidates found to export.' }, 404);
        }
        const headers = [
            'Name', 'Email', 'Phone', 'Location', 'Experience', 'Education',
            'Skills', 'Match Score', 'Status', 'LinkedIn', 'GitHub', 'Portfolio',
            'Certifications', 'Languages', 'Summary', 'University', 'Graduation Year',
            'Work History', 'Filename'
        ];
        const rows = all.map((cand) => {
            const skills = safeJsonParse(cand.skills).join(', ');
            const certs = safeJsonParse(cand.certifications).join(', ');
            const langs = safeJsonParse(cand.languages).join(', ');
            const workHistoryArr = safeJsonParse(cand.workHistory);
            const workHistory = workHistoryArr.map((w) => `${w.title} @ ${w.company} (${w.duration})`).join('; ');
            return [
                `"${(cand.name || '').replace(/"/g, '""')}"`,
                `"${(cand.email || '').replace(/"/g, '""')}"`,
                `"${(cand.phone || '').replace(/"/g, '""')}"`,
                `"${(cand.location || '').replace(/"/g, '""')}"`,
                `"${(cand.experience || '').replace(/"/g, '""')}"`,
                `"${(cand.education || '').replace(/"/g, '""')}"`,
                `"${skills.replace(/"/g, '""')}"`,
                cand.matchScore,
                `"${(cand.status || '').replace(/"/g, '""')}"`,
                `"${(cand.linkedin || '').replace(/"/g, '""')}"`,
                `"${(cand.github || '').replace(/"/g, '""')}"`,
                `"${(cand.portfolio || '').replace(/"/g, '""')}"`,
                `"${certs.replace(/"/g, '""')}"`,
                `"${langs.replace(/"/g, '""')}"`,
                `"${(cand.summary || '').substring(0, 200).replace(/"/g, '""')}"`,
                `"${(cand.university || '').replace(/"/g, '""')}"`,
                `"${(cand.gradYear || '').replace(/"/g, '""')}"`,
                `"${workHistory.replace(/"/g, '""')}"`,
                `"${(cand.filename || '').replace(/"/g, '""')}"`,
            ].join(',');
        });
        const csvContent = [headers.join(','), ...rows].join('\n');
        return c.text(csvContent, 200, {
            'Content-Type': 'text/csv',
            'Content-Disposition': 'attachment; filename="candidates_report.csv"',
        });
    }
    catch (error) {
        console.error('CSV Export Error:', error);
        return c.json({ error: 'Failed to generate CSV' }, 500);
    }
});
// DELETE /candidates/:id
candidatesRouter.delete('/:id', requireAuth, async (c) => {
    try {
        const userId = c.get('userId');
        const id = parseInt(c.req.param('id'));
        const existing = await db.select().from(candidates).where(eq(candidates.id, id));
        if (existing.length === 0 || existing[0].createdBy !== userId) {
            return c.json({ error: 'Candidate not found or unauthorized' }, 403);
        }
        await db.delete(candidates).where(eq(candidates.id, id));
        return c.json({ message: 'Candidate deleted' });
    }
    catch {
        return c.json({ error: 'Failed to delete candidate' }, 500);
    }
});
function safeJsonParse(str) {
    try {
        return JSON.parse(str || '[]');
    }
    catch {
        return [];
    }
}
export default candidatesRouter;
