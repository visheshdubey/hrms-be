import bcrypt from 'bcryptjs';
import { eq, sql } from 'drizzle-orm';
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
  accountStageTemplates,
  notifications,
  APP_STATUSES,
} from './schema.js';
import { copyAccountStageTemplatesToJob } from '../lib/stages.js';

type AppStatus = typeof APP_STATUSES[number];

const DEMO_PASSWORD = 'Demo@12345';

const DEMO_USERS = [
  { name: 'Alex Recruiter', email: 'recruiter@demo.com', role: 'recruiter_admin' as const, portalType: 'recruiter' as const },
  { name: 'Sam Staff', email: 'staff@demo.com', role: 'recruited_staff' as const, portalType: 'recruiter' as const },
  { name: 'Olivia Org Admin', email: 'orgadmin@demo.com', role: 'org_admin' as const, portalType: 'org' as const },
  { name: 'Owen Org Staff', email: 'orgstaff@demo.com', role: 'org_staff' as const, portalType: 'org' as const },
];

async function seed() {
  try {
    // Skip if demo user already exists
    const existing = await db.select().from(users).where(eq(users.email, DEMO_USERS[0].email)).limit(1);
    if (existing.length > 0) {
      console.log(`✅ Demo data already exists (${DEMO_USERS[0].email}). Skipping seed.`);
      console.log('   Run npm run db:seed:users to refresh all portal test logins.');
      return;
    }

    console.log('🌱 Seeding demo enterprise scenario…');

    /* ── 1. Organization ── */
    const [org] = await db.insert(organizations).values({
      name: 'Demo Recruitment Co.',
      logo: '',
      defaults: JSON.stringify({ defaultJobType: 'Full-time', defaultLocation: 'Remote', notifyOnApplication: true }),
    }).returning();

    /* ── 2. Demo portal users (all roles) ── */
    const hashedPassword = await bcrypt.hash(DEMO_PASSWORD, 10);
    const insertedUsers = [];
    for (const demoUser of DEMO_USERS) {
      const [row] = await db.insert(users).values({
        name: demoUser.name,
        email: demoUser.email,
        password: hashedPassword,
        isVerified: 1,
        role: demoUser.role,
        portalType: demoUser.portalType,
        organizationId: org.id,
      }).returning();
      insertedUsers.push(row);
    }

    const userId = insertedUsers[0].id;

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

    /* ── 4b. Client stage templates + jobs (4 statuses) linked to accounts ── */
    const defaultClientStages = [
      { name: 'Candidate applies', orderIndex: 0, stageType: 'application' as const },
      { name: 'Email notification', orderIndex: 1, stageType: 'application' as const },
      { name: 'Technical round', orderIndex: 2, stageType: 'interview' as const },
      { name: 'Management round', orderIndex: 3, stageType: 'interview' as const },
      { name: 'Offer letter', orderIndex: 4, stageType: 'application' as const },
      { name: 'Job closed', orderIndex: 5, stageType: 'application' as const },
    ];

    for (const account of accountRows) {
      for (const stage of defaultClientStages) {
        await db.insert(accountStageTemplates).values({
          accountId: account.id,
          name: stage.name,
          orderIndex: stage.orderIndex,
          stageType: stage.stageType,
        });
      }
    }

    const [jobFrontend] = await db.insert(jobs).values({
      title: 'Senior Frontend Developer',
      department: 'Engineering',
      status: 'submission_in_progress',
      type: 'Full-time',
      location: 'Remote',
      applicants: 0,
      description: 'React, TypeScript, and modern UI architecture.',
      accountId: accountRows[0].id,
      createdBy: userId,
    }).returning();

    await copyAccountStageTemplatesToJob(accountRows[0].id, jobFrontend.id);

    const [jobBackend] = await db.insert(jobs).values({
      title: 'Backend Engineer',
      department: 'Engineering',
      status: 'ready',
      type: 'Full-time',
      location: 'Hybrid',
      applicants: 0,
      description: 'Node.js, Hono, and PostgreSQL experience required.',
      accountId: accountRows[1].id,
      createdBy: userId,
    }).returning();

    await copyAccountStageTemplatesToJob(accountRows[1].id, jobBackend.id);

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

    await copyAccountStageTemplatesToJob(accountRows[2].id, jobPM.id);

    const [jobUX] = await db.insert(jobs).values({
      title: 'UX Designer',
      department: 'Design',
      status: 'closed',
      type: 'Contract',
      location: 'Remote',
      applicants: 0,
      description: 'Figma, design systems, and user research.',
      accountId: accountRows[3].id,
      createdBy: userId,
    }).returning();

    await copyAccountStageTemplatesToJob(accountRows[3].id, jobUX.id);

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

    // Sync denormalized applicants from real application rows
    for (const job of [jobFrontend, jobBackend, jobPM, jobUX]) {
      const [{ count }] = await db
        .select({ count: sql<number>`cast(count(*) as int)` })
        .from(applications)
        .where(eq(applications.jobId, job.id));
      await db.update(jobs).set({ applicants: Number(count) }).where(eq(jobs.id, job.id));
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

    /* ── Demo notifications (header bell) ── */
    const demoNotifications = [
      {
        title: 'Welcome to HRMS',
        body: 'Your demo workspace is ready. Start with Jobs or Clients.',
        type: 'info',
      },
      {
        title: 'New application received',
        body: 'A candidate was added to Senior Frontend Developer.',
        type: 'application',
      },
      {
        title: 'Pipeline stage updated',
        body: 'An application moved to Technical round.',
        type: 'stage_change',
      },
    ];

    for (const member of insertedUsers) {
      for (const [index, item] of demoNotifications.entries()) {
        await db.insert(notifications).values({
          userId: member.id,
          title: item.title,
          body: item.body,
          type: item.type,
          isRead: index === 0 ? 1 : 0,
          relatedType: item.type === 'application' ? 'application' : '',
        });
      }
    }

    // Silence unused variable warning for draft job
    void jobPM;

    console.log('✅ Demo seed complete!');
    console.log('   Organization : Demo Recruitment Co.');
    console.log('   Test logins (all passwords: Demo@12345):');
    for (const demoUser of DEMO_USERS) {
      console.log(`     ${demoUser.portalType.padEnd(10)} ${demoUser.email.padEnd(22)} (${demoUser.role})`);
    }
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
