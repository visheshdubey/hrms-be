/**
 * Federated Sourcing Gateway
 * ──────────────────────────────────────────────────────────────────────────
 *   GET|POST /sourcing/internal  → org-scoped candidate DB (Drizzle/SQLite)
 *   GET|POST /sourcing/linkedin  → Proxycurl / Google CSE X-Ray (or simulated)
 *   GET|POST /sourcing/github    → GitHub REST Search API (live)
 *
 * Response envelope:
 *   { source, query, page, pageSize, total, took, results, meta? }
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import { candidates, users } from '../db/schema.js';
import { eq, inArray, and, or, sql, type SQL } from 'drizzle-orm';
import { requireAuth, type AppContext } from '../middleware.js';
import { getOrgMemberIdsFromContext } from '../lib/orgScope.js';

const sourcingRouter = new Hono<AppContext>({ strict: false });

const PROXYCURL_API_KEY = process.env.PROXYCURL_API_KEY ?? '';
const GOOGLE_CSE_API_KEY = process.env.GOOGLE_CSE_API_KEY ?? '';
const GOOGLE_CSE_CX = process.env.GOOGLE_CSE_CX ?? '';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';

/* ════════════════════════════════════════════════════════════════════════
 * Shared sub-schemas
 * ════════════════════════════════════════════════════════════════════════ */

const numRange = z
  .object({
    min: z.coerce.number().nonnegative().optional(),
    max: z.coerce.number().nonnegative().optional(),
  })
  .partial()
  .optional();

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

const tokenGroup = z
  .object({
    keywords: z.array(z.string()).default([]),
    skills: z.array(z.string()).default([]),
    jobTitles: z.array(z.string()).default([]),
    previousEmployers: z.array(z.string()).default([]),
  })
  .partial();

const internalSchema = z.object({
  q: z.string().optional(),
  location: z
    .object({
      mode: z.enum(['city', 'zip', 'country_state']).default('city'),
      value: z.string().default(''),
      radiusMiles: z.coerce.number().min(0).max(500).default(0),
    })
    .partial()
    .optional(),
  willingToRelocate: z.boolean().default(false),
  workedInCountry: z.string().optional(),
  onlyRecommended: z.boolean().default(false),
  languagesKnown: z.array(z.string()).default([]),
  gender: z.enum(['', 'male', 'female', 'other']).default(''),
  qualification: z.string().optional(),
  subQualification: z.string().optional(),
  institution: z.string().optional(),
  candidateStatus: z.array(z.string()).default([]),
  poolStatus: z.array(z.string()).default([]),
  candidateType: z.string().optional(),
  lastUpdatedDays: z.coerce.number().int().min(0).optional(),
  remoteStatus: z.enum(['', 'on_site', 'remote', 'hybrid']).default(''),
  experience: numRange,
  experienceLevel: z.string().optional(),
  currentPayRate: z
    .object({ min: z.coerce.number().optional(), max: z.coerce.number().optional(), currency: z.string().optional() })
    .partial()
    .optional(),
  expectedPayRate: z
    .object({ min: z.coerce.number().optional(), max: z.coerce.number().optional(), period: z.string().optional() })
    .partial()
    .optional(),
  noticePeriod: z.string().optional(),
  source: z.string().optional(),
  include: tokenGroup.optional(),
  exclude: tokenGroup.optional(),
  ...pagination,
});

type InternalPayload = z.infer<typeof internalSchema>;

const linkedinSchema = z.object({
  q: z.string().optional(),
  keywords: z.array(z.string()).default([]),
  companyName: z.string().optional(),
  location: z.string().optional(),
  experienceYears: numRange,
  salaryLPA: numRange,
  educationLevel: z.enum(['any', 'bachelors', 'masters', 'phd', 'diploma']).default('any'),
  workMode: z.enum(['any', 'remote', 'hybrid', 'onsite']).default('any'),
  noticePeriod: z.enum(['any', 'immediate', '15_days', '30_days', '60_days', '90_days']).default('any'),
  openToWork: z.boolean().default(false),
  ...pagination,
});

type LinkedInPayload = z.infer<typeof linkedinSchema>;

const githubSchema = z.object({
  query: z.string().min(1, 'Enter keywords, a username or a technology'),
  location: z.string().optional(),
  primaryLanguage: z.string().default('any'),
  sortBy: z.enum(['best_match', 'stars', 'forks', 'followers', 'repositories', 'joined']).default('best_match'),
  order: z.enum(['desc', 'asc']).default('desc'),
  hireableOnly: z.boolean().default(false),
  minRepos: z.coerce.number().int().min(0).optional(),
  minFollowers: z.coerce.number().int().min(0).optional(),
  ...pagination,
});

type GithubPayload = z.infer<typeof githubSchema>;

interface NormalizedCandidate {
  id: string;
  source: 'internal' | 'linkedin' | 'github';
  name: string;
  headline: string;
  location: string;
  skills: string[];
  experienceYears: number | null;
  avatarUrl: string | null;
  externalUrl: string | null;
  matchScore: number;
  flags: Record<string, boolean>;
}

interface SearchMeta {
  simulated?: boolean;
  notice?: string;
  provider?: string;
}

function envelope<T extends object>(
  source: NormalizedCandidate['source'],
  query: T,
  page: number,
  pageSize: number,
  total: number,
  took: number,
  results: NormalizedCandidate[],
  meta?: SearchMeta,
) {
  return { source, query, page, pageSize, total, took, results, meta };
}

function safeArray(v: unknown): string[] {
  try {
    const parsed = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return typeof v === 'string' && v ? v.split(',').map((s) => s.trim()) : [];
  }
}

/** Case-insensitive LIKE for SQLite (ilike equivalent). */
function ilike(column: unknown, term: string): SQL {
  const pattern = `%${term.toLowerCase()}%`;
  return sql`lower(${column}) like ${pattern}`;
}

function mapInternalRow(r: typeof candidates.$inferSelect): NormalizedCandidate {
  const skills = safeArray(r.skills);
  return {
    id: `internal-${r.id}`,
    source: 'internal',
    name: r.name || 'Unknown',
    headline: r.summary || r.experience || r.education || '—',
    location: r.location || '',
    skills,
    experienceYears: parseFloat(String(r.experience).replace(/[^0-9.]/g, '')) || null,
    avatarUrl: null,
    externalUrl: r.linkedin || r.github || r.portfolio || null,
    matchScore: Math.round(r.matchScore ?? 0),
    flags: { recommended: (r.matchScore ?? 0) >= 80 },
  };
}

async function searchInternal(
  c: { get: (key: string) => unknown },
  p: InternalPayload,
  started: number,
) {
  const memberIds = await getOrgMemberIdsFromContext(c);
  if (!memberIds || memberIds.length === 0) {
    return envelope('internal', p, p.page, p.pageSize, 0, Date.now() - started, []);
  }

  const filters: SQL[] = [inArray(candidates.createdBy, memberIds)];

  const quickQuery = (p.q ?? '').trim();
  const includeTokens = [
    ...(quickQuery ? [quickQuery] : []),
    ...(p.include?.keywords ?? []),
    ...(p.include?.skills ?? []),
    ...(p.include?.jobTitles ?? []),
  ].filter(Boolean);

  if (includeTokens.length > 0) {
    const tokenClauses = includeTokens.flatMap((token) => [
      ilike(candidates.name, token),
      ilike(candidates.email, token),
      ilike(candidates.summary, token),
      ilike(candidates.skills, token),
      ilike(candidates.experience, token),
    ]);
    const combined = or(...tokenClauses);
    if (combined) filters.push(combined);
  }

  if (p.location?.value) {
    filters.push(ilike(candidates.location, p.location.value));
  }

  if (p.onlyRecommended) {
    filters.push(sql`${candidates.matchScore} >= 80`);
  }

  let rows = await db
    .select()
    .from(candidates)
    .where(and(...filters))
    .limit(500);

  const excludeTokens = [
    ...(p.exclude?.keywords ?? []),
    ...(p.exclude?.skills ?? []),
    ...(p.exclude?.jobTitles ?? []),
  ].filter(Boolean);

  rows = rows.filter((r) => {
    const blob = `${r.skills} ${r.summary} ${r.experience} ${r.name} ${r.email}`.toLowerCase();
    if (excludeTokens.some((tok) => blob.includes(tok.toLowerCase()))) return false;
    if (p.experience?.min != null || p.experience?.max != null) {
      const yrs = parseFloat(String(r.experience).replace(/[^0-9.]/g, '')) || 0;
      if (p.experience?.min != null && yrs < p.experience.min) return false;
      if (p.experience?.max != null && yrs > p.experience.max) return false;
    }
    return true;
  });

  const total = rows.length;
  const start = (p.page - 1) * p.pageSize;
  const paged = rows.slice(start, start + p.pageSize);
  const results = paged.map(mapInternalRow);

  return envelope('internal', p, p.page, p.pageSize, total, Date.now() - started, results);
}

async function searchGitHub(p: GithubPayload): Promise<{ total: number; page: NormalizedCandidate[] }> {
  const qParts: string[] = [];
  if (p.query.trim()) qParts.push(p.query.trim());
  if (p.location?.trim()) qParts.push(`location:${p.location.trim()}`);
  if (p.primaryLanguage && p.primaryLanguage !== 'any') qParts.push(`language:${p.primaryLanguage}`);
  if (p.hireableOnly) qParts.push('is:hireable');
  if (p.minRepos != null && p.minRepos > 0) qParts.push(`repos:>=${p.minRepos}`);
  if (p.minFollowers != null && p.minFollowers > 0) qParts.push(`followers:>=${p.minFollowers}`);

  const q = qParts.join('+') || p.query;
  const sortParam = p.sortBy === 'best_match' ? '' : p.sortBy;
  const perPage = Math.min(p.pageSize, 100);
  const params = new URLSearchParams({
    q,
    per_page: String(perPage),
    page: String(p.page),
    order: p.order,
  });
  if (sortParam) params.set('sort', sortParam);

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'HRMS-Sourcing-Gateway',
  };
  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }

  const res = await fetch(`https://api.github.com/search/users?${params.toString()}`, { headers });

  if (res.status === 403) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    throw new Error(
      remaining === '0'
        ? 'GitHub API rate limit exceeded. Configure GITHUB_TOKEN or try again later.'
        : 'GitHub API access denied. Check GITHUB_TOKEN permissions.',
    );
  }
  if (res.status === 422) {
    throw new Error('Invalid GitHub search query. Try simpler keywords.');
  }
  if (!res.ok) {
    throw new Error(`GitHub search failed (HTTP ${res.status})`);
  }

  const data = (await res.json()) as {
    total_count?: number;
    items?: Array<{
      id: number;
      login: string;
      avatar_url: string;
      html_url: string;
      score?: number;
    }>;
  };

  const items = data.items ?? [];
  const results: NormalizedCandidate[] = items.map((u) => ({
    id: `github-${u.id}`,
    source: 'github',
    name: u.login,
    headline: `GitHub developer · ${p.primaryLanguage !== 'any' ? p.primaryLanguage : 'Open source'}`,
    location: p.location ?? '',
    skills: p.primaryLanguage !== 'any' ? [p.primaryLanguage] : [],
    experienceYears: null,
    avatarUrl: u.avatar_url,
    externalUrl: u.html_url,
    matchScore: Math.min(99, Math.max(40, Math.round((u.score ?? 1) * 15))),
    flags: { hireable: p.hireableOnly },
  }));

  return { total: data.total_count ?? results.length, page: results };
}

async function searchLinkedIn(
  p: LinkedInPayload,
): Promise<{ total: number; page: NormalizedCandidate[]; meta: SearchMeta }> {
  const keywords = [
    ...(p.q ? [p.q] : []),
    ...p.keywords,
    p.companyName,
    p.location,
  ].filter(Boolean) as string[];

  if (PROXYCURL_API_KEY) {
    // Architecture hook — Proxycurl person search (requires paid API key)
    // POST https://nubela.co/proxycurl/api/v2/linkedin/person/search
    return {
      total: 0,
      page: [],
      meta: {
        simulated: true,
        provider: 'proxycurl',
        notice:
          'PROXYCURL_API_KEY is set but person-search integration is pending. Wire Proxycurl endpoint here.',
      },
    };
  }

  if (GOOGLE_CSE_API_KEY && GOOGLE_CSE_CX && keywords.length > 0) {
    const xrayQuery = `site:linkedin.com/in ${keywords.join(' ')}`;
    const params = new URLSearchParams({
      key: GOOGLE_CSE_API_KEY,
      cx: GOOGLE_CSE_CX,
      q: xrayQuery,
      num: String(Math.min(p.pageSize, 10)),
      start: String((p.page - 1) * p.pageSize + 1),
    });

    const res = await fetch(`https://www.googleapis.com/customsearch/v1?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`Google X-Ray search failed (HTTP ${res.status})`);
    }

    const data = (await res.json()) as {
      searchInformation?: { totalResults?: string };
      items?: Array<{ title?: string; link?: string; snippet?: string }>;
    };

    const items = data.items ?? [];
    const results: NormalizedCandidate[] = items.map((item, i) => {
      const title = item.title ?? 'LinkedIn Profile';
      const name = title.replace(/\s*[-|].*$/, '').trim() || 'LinkedIn Candidate';
      return {
        id: `linkedin-cse-${p.page}-${i}`,
        source: 'linkedin',
        name,
        headline: item.snippet ?? 'LinkedIn profile (X-Ray)',
        location: p.location ?? '',
        skills: p.keywords.slice(0, 5),
        experienceYears: null,
        avatarUrl: null,
        externalUrl: item.link ?? null,
        matchScore: 65 + (i % 25),
        flags: { openToWork: p.openToWork, xray: true },
      };
    });

    return {
      total: Number(data.searchInformation?.totalResults ?? results.length),
      page: results,
      meta: { provider: 'google_cse_xray' },
    };
  }

  // ── Simulated LinkedIn profiles for demo/presentation ──
  // Generates realistic candidates based on search keywords
  const firstNames = ['Aarav','Priya','Rohan','Sneha','Vikram','Ananya','Arjun','Kavita','Rahul','Meera',
    'Aditya','Neha','Siddharth','Pooja','Karthik','Divya','Amit','Ritu','Varun','Swati',
    'Nikhil','Shruti','Harsh','Anjali','Deepak','Nisha','Rajesh','Pallavi','Manish','Tanvi'];
  const lastNames = ['Sharma','Patel','Kumar','Singh','Reddy','Gupta','Mehta','Joshi','Verma','Iyer',
    'Nair','Chauhan','Malhotra','Kapoor','Rao','Das','Mishra','Thakur','Bhatia','Choudhary'];
  const companies = ['Infosys','TCS','Wipro','HCL Technologies','Tech Mahindra','Cognizant','Accenture',
    'Capgemini','IBM India','Amazon','Google','Microsoft','Flipkart','PhonePe','Razorpay','Zomato','Swiggy',
    'Freshworks','Zoho','Paytm'];
  const cities = ['Bangalore','Mumbai','Delhi NCR','Hyderabad','Pune','Chennai','Noida','Gurugram','Kolkata','Ahmedabad'];
  const degrees = ['B.Tech','M.Tech','BCA','MCA','B.E.','MBA','M.Sc.','PhD'];
  const universities = ['IIT Delhi','IIT Bombay','IIT Madras','BITS Pilani','NIT Trichy','VIT','SRM','IIIT Hyderabad','DTU','NSIT'];

  const searchTerms = keywords.length > 0 ? keywords : ['Software Developer'];
  const totalSim = 12 + Math.floor(Math.random() * 8); // 12-20 candidates
  const startIdx = (p.page - 1) * p.pageSize;
  const endIdx = Math.min(startIdx + p.pageSize, totalSim);

  const simResults: NormalizedCandidate[] = [];
  for (let i = startIdx; i < endIdx; i++) {
    const fn = firstNames[i % firstNames.length];
    const ln = lastNames[(i * 7 + 3) % lastNames.length];
    const company = companies[(i * 11 + 5) % companies.length];
    const city = p.location?.trim() || cities[i % cities.length];
    const expYears = 1 + (i % 15);
    const degree = degrees[i % degrees.length];
    const uni = universities[(i * 3) % universities.length];

    const skillPool = [...searchTerms];
    const extraSkills = ['React','Node.js','Python','Java','TypeScript','AWS','Docker','Kubernetes','MongoDB','PostgreSQL','Redis','GraphQL','REST API','Microservices','CI/CD'];
    for (let s = 0; s < 3 + (i % 4); s++) {
      const sk = extraSkills[(i + s * 7) % extraSkills.length];
      if (!skillPool.includes(sk)) skillPool.push(sk);
    }

    simResults.push({
      id: `linkedin-sim-${p.page}-${i}`,
      source: 'linkedin',
      name: `${fn} ${ln}`,
      headline: `${searchTerms[0]} at ${company} | ${degree} from ${uni} | ${expYears}+ yrs`,
      location: city,
      skills: skillPool.slice(0, 6),
      experienceYears: expYears,
      avatarUrl: null,
      externalUrl: `https://linkedin.com/in/${fn.toLowerCase()}-${ln.toLowerCase()}-${100000 + i}`,
      matchScore: Math.max(45, Math.min(98, 90 - i * 2 + Math.floor(Math.random() * 10))),
      flags: { openToWork: i % 3 === 0, simulated: true },
    });
  }

  return {
    total: totalSim,
    page: simResults,
    meta: {
      simulated: true,
      provider: 'simulated',
      notice:
        'Showing simulated LinkedIn profiles. Configure PROXYCURL_API_KEY or GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX for live results.',
    },
  };
}

/* ── GET /sourcing/internal?q=... ── */
sourcingRouter.get('/internal', requireAuth, async (c) => {
  const started = Date.now();
  try {
    const q = c.req.query('q')?.trim() ?? '';
    if (!q) return c.json({ error: 'Query parameter q is required' }, 400);

    const page = Math.max(1, Number(c.req.query('page') ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(c.req.query('pageSize') ?? 20)));

    const payload: InternalPayload = internalSchema.parse({ q, page, pageSize });
    return c.json(await searchInternal(c, payload, started));
  } catch (err) {
    console.error('[sourcing] GET internal failed:', err);
    return c.json({ error: 'Internal sourcing search failed' }, 500);
  }
});

sourcingRouter.post('/internal', requireAuth, zValidator('json', internalSchema), async (c) => {
  const started = Date.now();
  try {
    const p = c.req.valid('json') as InternalPayload;
    return c.json(await searchInternal(c, p, started));
  } catch (err) {
    console.error('[sourcing] POST internal failed:', err);
    return c.json({ error: 'Internal sourcing search failed' }, 500);
  }
});

/* ── GET /sourcing/github?q=... ── */
sourcingRouter.get('/github', requireAuth, async (c) => {
  const started = Date.now();
  try {
    const query = c.req.query('q')?.trim() ?? '';
    if (!query) return c.json({ error: 'Query parameter q is required' }, 400);

    const page = Math.max(1, Number(c.req.query('page') ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(c.req.query('pageSize') ?? 20)));

    const p = githubSchema.parse({ query, page, pageSize });
    const { total, page: results } = await searchGitHub(p);
    return c.json(envelope('github', { query: p.query, page, pageSize }, page, pageSize, total, Date.now() - started, results));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'GitHub sourcing search failed';
    console.error('[sourcing] GET github failed:', message);
    return c.json({ error: message }, 502);
  }
});

sourcingRouter.post('/github', requireAuth, zValidator('json', githubSchema), async (c) => {
  const started = Date.now();
  try {
    const p = c.req.valid('json') as GithubPayload;
    const { total, page: results } = await searchGitHub(p);
    return c.json(envelope('github', p, p.page, p.pageSize, total, Date.now() - started, results));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'GitHub sourcing search failed';
    console.error('[sourcing] POST github failed:', message);
    return c.json({ error: message }, 502);
  }
});

/* ── GET /sourcing/linkedin?q=... ── */
sourcingRouter.get('/linkedin', requireAuth, async (c) => {
  const started = Date.now();
  try {
    const q = c.req.query('q')?.trim() ?? '';
    if (!q) return c.json({ error: 'Query parameter q is required' }, 400);

    const page = Math.max(1, Number(c.req.query('page') ?? 1));
    const pageSize = Math.min(100, Math.max(1, Number(c.req.query('pageSize') ?? 20)));

    const p = linkedinSchema.parse({ q, keywords: q.split(/\s+/).filter(Boolean), page, pageSize });
    const { total, page: results, meta } = await searchLinkedIn(p);
    return c.json(envelope('linkedin', { q, page, pageSize }, page, pageSize, total, Date.now() - started, results, meta));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'LinkedIn sourcing search failed';
    console.error('[sourcing] GET linkedin failed:', message);
    return c.json({ error: message }, 502);
  }
});

sourcingRouter.post('/linkedin', requireAuth, zValidator('json', linkedinSchema), async (c) => {
  const started = Date.now();
  try {
    const p = c.req.valid('json') as LinkedInPayload;
    const { total, page: results, meta } = await searchLinkedIn(p);
    return c.json(envelope('linkedin', p, p.page, p.pageSize, total, Date.now() - started, results, meta));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'LinkedIn sourcing search failed';
    console.error('[sourcing] POST linkedin failed:', message);
    return c.json({ error: message }, 502);
  }
});

export default sourcingRouter;
