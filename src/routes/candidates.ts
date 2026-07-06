import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import { candidates, jobs, users } from '../db/schema.js';
import { eq, desc, inArray } from 'drizzle-orm';
import { requireAuth, type AppContext } from '../middleware.js';
import { canAccessByCreator } from '../lib/orgScope.js';

const candidatesRouter = new Hono<AppContext>({ strict: false });

const candidateSchema = z.object({
  jobId: z.number().optional().nullable(),
  job_id: z.union([z.number(), z.string()]).optional().nullable(),
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
  source: z.string().optional(),
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

// GET /candidates — list all candidates visible to the authenticated user's organization
candidatesRouter.get('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;

    let all;
    if (orgId != null) {
      const orgMembers = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.organizationId, orgId));

      const memberIds = orgMembers.map((u: any) => u.id);
      if (memberIds.length === 0) return c.json([]);

      all = await db
        .select()
        .from(candidates)
        .where(inArray(candidates.createdBy, memberIds))
        .orderBy(desc(candidates.matchScore));
    } else {
      all = await db
        .select()
        .from(candidates)
        .where(eq(candidates.createdBy, userId))
        .orderBy(desc(candidates.matchScore));
    }

    const parsed = all.map((c: any, i: number) => ({
      ...c,
      skills: safeJsonParse(c.skills),
      certifications: safeJsonParse(c.certifications),
      languages: safeJsonParse(c.languages),
      workHistory: safeJsonParse(c.workHistory),
      rank: i + 1,
    }));
    return c.json(parsed);
  } catch {
    return c.json({ error: 'Failed to fetch candidates' }, 500);
  }
});

// POST /candidates — save a parsed candidate from ATS
candidatesRouter.post('/', requireAuth, zValidator('json', candidateSchema), async (c) => {
  try {
    const body = c.req.valid('json');
    const {
      jobId, job_id, filename, name, email, phone, location,
      education, experience, skills, match_score, status, source,
      linkedin, github, portfolio, certifications, languages,
      summary, university, grad_year, work_history, fingerprint,
    } = body;

    // Resolve jobId from either camelCase or snake_case
    const resolvedJobId = jobId ?? (job_id ? Number(job_id) : null) ?? null;

    // Duplicate detection: check fingerprint
    if (fingerprint) {
      const userId = c.get('userId') as number;
      const existing = await db.select()
        .from(candidates)
        .where(eq(candidates.fingerprint, fingerprint));
      
      const ownedDuplicate = existing.find((e: any) => e.createdBy === userId);
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
      jobId: resolvedJobId || null,
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
      source: source || 'Internal',
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
      createdBy: c.get('userId') as number,
    }).returning();

    // Increment applicant count for the job
    if (resolvedJobId) {
      const job = await db.select().from(jobs).where(eq(jobs.id, resolvedJobId));
      if (job.length > 0) {
        await db.update(jobs)
          .set({ applicants: job[0].applicants + 1 })
          .where(eq(jobs.id, resolvedJobId));
      }
    }

    return c.json({
      ...created[0],
      skills: safeJsonParse(created[0].skills),
      certifications: safeJsonParse(created[0].certifications),
      languages: safeJsonParse(created[0].languages),
      workHistory: safeJsonParse(created[0].workHistory),
    }, 201);
  } catch (error) {
    console.error(error);
    return c.json({ error: 'Failed to save candidate' }, 500);
  }
});

// GET /candidates/csv — download CSV report for the organization's candidates
candidatesRouter.get('/csv', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;

    let all;
    if (orgId != null) {
      const orgMembers = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.organizationId, orgId));
      const memberIds = orgMembers.map((u: any) => u.id);
      all = memberIds.length === 0
        ? []
        : await db.select().from(candidates)
            .where(inArray(candidates.createdBy, memberIds))
            .orderBy(desc(candidates.matchScore));
    } else {
      all = await db
        .select()
        .from(candidates)
        .where(eq(candidates.createdBy, userId))
        .orderBy(desc(candidates.matchScore));
    }

    if (all.length === 0) {
      return c.json({ error: 'No candidates found to export.' }, 404);
    }

    const headers = [
      'Name', 'Email', 'Phone', 'Location', 'Experience', 'Education',
      'Skills', 'Match Score', 'Status', 'LinkedIn', 'GitHub', 'Portfolio',
      'Certifications', 'Languages', 'Summary', 'University', 'Graduation Year',
      'Work History', 'Filename'
    ];

    const rows = all.map((cand: any) => {
      const skills = safeJsonParse(cand.skills).join(', ');
      const certs = safeJsonParse(cand.certifications).join(', ');
      const langs = safeJsonParse(cand.languages).join(', ');
      const workHistoryArr = safeJsonParse(cand.workHistory);
      const workHistory = workHistoryArr.map((w: any) => `${w.title} @ ${w.company} (${w.duration})`).join('; ');

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
  } catch (error) {
    console.error('CSV Export Error:', error);
    return c.json({ error: 'Failed to generate CSV' }, 500);
  }
});

// GET /candidates/:id — single candidate (must come after /csv)
candidatesRouter.get('/:id', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const row = await db.select().from(candidates).where(eq(candidates.id, id)).limit(1);
    if (row.length === 0) return c.json({ error: 'Candidate not found' }, 404);

    if (!await canAccessByCreator(orgId, userId, row[0].createdBy)) {
      return c.json({ error: 'Candidate not found' }, 404);
    }

    const cand = row[0];
    return c.json({
      ...cand,
      skills:         safeJsonParse(cand.skills),
      certifications: safeJsonParse(cand.certifications),
      languages:      safeJsonParse(cand.languages),
      workHistory:    safeJsonParse(cand.workHistory),
    });
  } catch {
    return c.json({ error: 'Failed to fetch candidate' }, 500);
  }
});

const updateSchema = z.object({
  name:         z.string().optional(),
  email:        z.string().optional(),
  phone:        z.string().optional(),
  location:     z.string().optional(),
  education:    z.string().optional(),
  experience:   z.string().optional(),
  skills:       z.union([z.string(), z.array(z.string())]).optional(),
  status:       z.string().optional(),
  linkedin:     z.string().optional(),
  github:       z.string().optional(),
  portfolio:    z.string().optional(),
  summary:      z.string().optional(),
  university:   z.string().optional(),
  grad_year:    z.string().optional(),
  certifications: z.union([z.string(), z.array(z.string())]).optional(),
  languages:    z.union([z.string(), z.array(z.string())]).optional(),
  work_history: z.union([z.string(), z.array(z.any())]).optional(),
});

// PUT /candidates/:id — update profile fields
candidatesRouter.put('/:id', requireAuth, zValidator('json', updateSchema), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    const existing = await db.select().from(candidates).where(eq(candidates.id, id)).limit(1);
    if (existing.length === 0) return c.json({ error: 'Candidate not found' }, 404);
    const orgId = c.get('organizationId') as number | null;
    if (!await canAccessByCreator(orgId, userId, existing[0].createdBy)) {
      return c.json({ error: 'Unauthorized' }, 403);
    }

    const body = c.req.valid('json');

    const patch: Record<string, unknown> = {};
    if (body.name        != null) patch.name        = body.name;
    if (body.email       != null) patch.email       = body.email;
    if (body.phone       != null) patch.phone       = body.phone;
    if (body.location    != null) patch.location    = body.location;
    if (body.education   != null) patch.education   = body.education;
    if (body.experience  != null) patch.experience  = body.experience;
    if (body.status      != null) patch.status      = body.status;
    if (body.linkedin    != null) patch.linkedin    = body.linkedin;
    if (body.github      != null) patch.github      = body.github;
    if (body.portfolio   != null) patch.portfolio   = body.portfolio;
    if (body.summary     != null) patch.summary     = body.summary;
    if (body.university  != null) patch.university  = body.university;
    if (body.grad_year   != null) patch.gradYear    = body.grad_year;
    if (body.skills         != null) patch.skills         = JSON.stringify(Array.isArray(body.skills)         ? body.skills         : []);
    if (body.certifications != null) patch.certifications = JSON.stringify(Array.isArray(body.certifications) ? body.certifications : []);
    if (body.languages      != null) patch.languages      = JSON.stringify(Array.isArray(body.languages)      ? body.languages      : []);
    if (body.work_history   != null) patch.workHistory    = JSON.stringify(Array.isArray(body.work_history)   ? body.work_history   : []);

    if (Object.keys(patch).length === 0) return c.json({ error: 'No fields to update' }, 400);

    const updated = await db.update(candidates).set(patch as any).where(eq(candidates.id, id)).returning();

    const u = updated[0];
    return c.json({
      ...u,
      skills:         safeJsonParse(u.skills),
      certifications: safeJsonParse(u.certifications),
      languages:      safeJsonParse(u.languages),
      workHistory:    safeJsonParse(u.workHistory),
    });
  } catch {
    return c.json({ error: 'Failed to update candidate' }, 500);
  }
});

// DELETE /candidates/:id
candidatesRouter.delete('/:id', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const orgId = c.get('organizationId') as number | null;
    const id = parseInt(c.req.param('id'));

    const existing = await db.select().from(candidates).where(eq(candidates.id, id));
    if (existing.length === 0) {
      return c.json({ error: 'Candidate not found or unauthorized' }, 403);
    }
    if (!await canAccessByCreator(orgId, userId, existing[0].createdBy)) {
      return c.json({ error: 'Candidate not found or unauthorized' }, 403);
    }
    
    await db.delete(candidates).where(eq(candidates.id, id));
    return c.json({ message: 'Candidate deleted' });
  } catch {
    return c.json({ error: 'Failed to delete candidate' }, 500);
  }
});

function safeJsonParse(str: string | null): any[] {
  try { return JSON.parse(str || '[]'); } catch { return []; }
}

export default candidatesRouter;
