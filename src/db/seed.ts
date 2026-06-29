import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from './index.js';
import {
  organizations,
  users,
  jobs,
  candidates,
  applications,
  applicationStageHistory,
  accounts,
  contacts,
  candidateGroups,
  candidateGroupMembers,
  APP_STATUSES,
} from './schema.js';

type AppStatus = typeof APP_STATUSES[number];

const DEMO_EMAIL = 'recruiter@demo.com';
const DEMO_PASSWORD = 'Demo@12345';

async function seed() {
  try {
    // Skip if demo user already exists
    const existing = await db.select().from(users).where(eq(users.email, DEMO_EMAIL)).limit(1);
    if (existing.length > 0) {
      console.log(`✅ Demo data already exists (${DEMO_EMAIL}). Skipping seed.`);
      return;
    }

    console.log('🌱 Seeding demo enterprise scenario…');

    /* ── 1. Organization ── */
    const [org] = await db.insert(organizations).values({
      name: 'Demo Recruitment Co.',
      logo: '',
      defaults: JSON.stringify({ defaultJobType: 'Full-time', defaultLocation: 'Remote', notifyOnApplication: true }),
    }).returning();

    /* ── 2. Recruiter Admin user ── */
    const hashedPassword = await bcrypt.hash(DEMO_PASSWORD, 10);
    const [admin] = await db.insert(users).values({
      name: 'Alex Recruiter',
      email: DEMO_EMAIL,
      password: hashedPassword,
      isVerified: 1,
      role: 'recruiter_admin',
      portalType: 'recruiter',
      organizationId: org.id,
    }).returning();

    const userId = admin.id;

    /* ── 3. Client accounts (5) ── */
    const demoAccounts = [
      { name: 'Acme Corporation', email: 'contact@acme.com', city: 'San Francisco', country: 'USA' },
      { name: 'Horizon Ventures', email: 'hr@horizonventures.io', city: 'New York', country: 'USA' },
      { name: 'BlueSky Analytics', email: 'talent@bluesky.io', city: 'Chicago', country: 'USA' },
      { name: 'NovaBuild Infra', email: 'careers@novabuild.com', city: 'Austin', country: 'USA' },
      { name: 'PineSoft Technologies', email: 'jobs@pinesoft.com', city: 'Seattle', country: 'USA' },
    ];

    const accountRows = [];
    for (const a of demoAccounts) {
      const [row] = await db.insert(accounts).values({
        name: a.name,
        status: 'active',
        type: 'client',
        email: a.email,
        city: a.city,
        country: a.country,
        website: `https://${a.name.toLowerCase().replace(/\s+/g, '')}.com`,
        organizationId: org.id,
        createdBy: userId,
        updatedAt: new Date().toISOString(),
      }).returning();
      accountRows.push(row);

      await db.insert(contacts).values({
        accountId: row.id,
        firstName: 'Primary',
        lastName: 'Contact',
        email: a.email,
        phone: '+1-555-0100',
        jobTitle: 'Hiring Manager',
        department: 'HR',
        status: 'active',
        organizationId: org.id,
        createdBy: userId,
        updatedAt: new Date().toISOString(),
      });
    }

    /* ── 4. Jobs (4 statuses) linked to accounts ── */
    const [jobFrontend] = await db.insert(jobs).values({
      title: 'Senior Frontend Developer',
      department: 'Engineering',
      status: 'submission_in_progress',
      type: 'Full-time',
      location: 'Remote',
      applicants: 3,
      description: 'React, TypeScript, and modern UI architecture.',
      accountId: accountRows[0].id,
      createdBy: userId,
    }).returning();

    const [jobBackend] = await db.insert(jobs).values({
      title: 'Backend Engineer',
      department: 'Engineering',
      status: 'ready',
      type: 'Full-time',
      location: 'Hybrid',
      applicants: 2,
      description: 'Node.js, Hono, and PostgreSQL experience required.',
      accountId: accountRows[1].id,
      createdBy: userId,
    }).returning();

    const [jobPM] = await db.insert(jobs).values({
      title: 'Product Manager',
      department: 'Product',
      status: 'draft',
      type: 'Full-time',
      location: 'On-site',
      applicants: 0,
      description: 'Own the hiring product roadmap end-to-end.',
      accountId: accountRows[2].id,
      createdBy: userId,
    }).returning();

    await db.insert(jobs).values({
      title: 'UX Designer',
      department: 'Design',
      status: 'closed',
      type: 'Contract',
      location: 'Remote',
      applicants: 1,
      description: 'Figma, design systems, and user research.',
      accountId: accountRows[3].id,
      createdBy: userId,
    });

    /* ── 5. Candidates (6) ── */
    const candidateData = [
      { name: 'Alice Johnson',  email: 'alice@demo.com',  matchScore: 92, skills: ['React', 'TypeScript', 'Tailwind'] },
      { name: 'Bob Smith',      email: 'bob@demo.com',      matchScore: 78, skills: ['Node.js', 'PostgreSQL', 'Docker'] },
      { name: 'Charlie Brown',  email: 'charlie@demo.com',  matchScore: 88, skills: ['Python', 'FastAPI', 'AWS'] },
      { name: 'Diana Prince',   email: 'diana@demo.com',    matchScore: 95, skills: ['React', 'GraphQL', 'CI/CD'] },
      { name: 'Evan Miller',    email: 'evan@demo.com',     matchScore: 71, skills: ['Java', 'Spring', 'Kafka'] },
      { name: 'Fiona Garcia',   email: 'fiona@demo.com',    matchScore: 84, skills: ['Figma', 'UX Research', 'Prototyping'] },
    ];

    const insertedCandidates = [];
    for (const c of candidateData) {
      const [row] = await db.insert(candidates).values({
        filename: `${c.name.toLowerCase().replace(' ', '_')}_resume.pdf`,
        name: c.name,
        email: c.email,
        phone: '+1-555-0100',
        location: 'Remote',
        education: 'B.Tech Computer Science',
        experience: '5+ years',
        skills: JSON.stringify(c.skills),
        matchScore: c.matchScore,
        status: 'New',
        summary: `Experienced professional — ${c.skills.join(', ')}.`,
        createdBy: userId,
      }).returning();
      insertedCandidates.push(row);
    }

    /* ── 6. Applications (6) across pipeline stages ── */
    type AppSeed = {
      jobId: number;
      candidateIdx: number;
      status: AppStatus;
      notes: string;
      history: { from: string | null; to: AppStatus }[];
    };

    const appSeeds: AppSeed[] = [
      {
        jobId: jobFrontend.id, candidateIdx: 0, status: 'offer',
        notes: 'Strong React portfolio. Offer extended.',
        history: [
          { from: null, to: 'applied' },
          { from: 'applied', to: 'in_review' },
          { from: 'in_review', to: 'shortlisted' },
          { from: 'shortlisted', to: 'interview_scheduled' },
          { from: 'interview_scheduled', to: 'offer' },
        ],
      },
      {
        jobId: jobFrontend.id, candidateIdx: 3, status: 'interview_scheduled',
        notes: 'Excellent system design answers.',
        history: [
          { from: null, to: 'applied' },
          { from: 'applied', to: 'in_review' },
          { from: 'in_review', to: 'shortlisted' },
          { from: 'shortlisted', to: 'interview_scheduled' },
        ],
      },
      {
        jobId: jobFrontend.id, candidateIdx: 4, status: 'rejected',
        notes: 'Insufficient frontend experience.',
        history: [
          { from: null, to: 'applied' },
          { from: 'applied', to: 'in_review' },
          { from: 'in_review', to: 'rejected' },
        ],
      },
      {
        jobId: jobBackend.id, candidateIdx: 1, status: 'shortlisted',
        notes: 'Solid Node.js background.',
        history: [
          { from: null, to: 'applied' },
          { from: 'applied', to: 'in_review' },
          { from: 'in_review', to: 'shortlisted' },
        ],
      },
      {
        jobId: jobBackend.id, candidateIdx: 2, status: 'in_review',
        notes: 'Reviewing Python-to-Node transition fit.',
        history: [
          { from: null, to: 'applied' },
          { from: 'applied', to: 'in_review' },
        ],
      },
      {
        jobId: jobBackend.id, candidateIdx: 5, status: 'applied',
        notes: 'New application — pending review.',
        history: [{ from: null, to: 'applied' }],
      },
    ];

    for (const seed of appSeeds) {
      const cand = insertedCandidates[seed.candidateIdx];
      const [app] = await db.insert(applications).values({
        jobId: seed.jobId,
        candidateId: cand.id,
        status: seed.status,
        notes: seed.notes,
        createdBy: userId,
      }).returning();

      for (const h of seed.history) {
        await db.insert(applicationStageHistory).values({
          applicationId: app.id,
          fromStatus: h.from,
          toStatus: h.to,
          note: h.from ? `Moved to ${h.to}` : 'Application created',
          changedBy: userId,
        });
      }
    }

    const [group] = await db.insert(candidateGroups).values({
      organizationId: org.id,
      name: 'Senior React engineers',
      description: 'Shortlist for frontend roles',
      createdBy: userId,
    }).returning();

    for (const cand of insertedCandidates.slice(0, 3)) {
      await db.insert(candidateGroupMembers).values({
        groupId: group.id,
        candidateId: cand.id,
      }).onConflictDoNothing();
    }

    // Silence unused variable warning for draft job
    void jobPM;

    console.log('✅ Demo seed complete!');
    console.log('   Organization : Demo Recruitment Co.');
    console.log(`   Login        : ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
    console.log('   Accounts     : 5 demo clients with contacts');
    console.log('   Jobs         : 4 (linked to accounts)');
    console.log('   Candidates   : 6');
    console.log('   Applications : 6 (full pipeline stages)');
    console.log('   Groups       : 1 candidate group');
  } catch (err) {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  }
}

seed();
