/**
 * Full local QA dataset (faker.js) — clients, jobs, candidates, applications,
 * tags, integrations, team users, notifications, tasks, and more.
 *
 * Usage:
 *   npm run db:demo          # reset DB + full seed (recommended)
 *   npm run db:seed:full     # seed only (skip if demo users already exist)
 *
 * Env tuning (optional):
 *   SEED_ACCOUNTS=30 SEED_JOBS=50 SEED_CANDIDATES=120 SEED_APPLICATIONS=100
 *   SEED_FORCE=1             # re-seed even if demo data exists (not for db:demo)
 */
import { faker } from '@faker-js/faker';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db } from './index.js';
import {
  APP_STATUSES,
  INTEGRATION_PLATFORMS,
  organizations,
  users,
  accounts,
  contacts,
  jobs,
  candidates,
  applications,
  applicationStageHistory,
  applicationTags,
  candidateTags,
  candidateGroups,
  candidateGroupMembers,
  accountStageTemplates,
  tags,
  integrations,
  notifications,
  orgSettings,
  rolesPermissions,
  tasks,
  campaigns,
  calendarEvents,
  submissions,
  interviews,
  savedReports,
  jobShortlists,
} from './schema.js';
import { copyAccountStageTemplatesToJob } from '../lib/stages.js';

type AppStatus = (typeof APP_STATUSES)[number];

const DEMO_PASSWORD = 'Demo@12345';

const DEMO_USERS = [
  { name: 'Alex Recruiter', email: 'recruiter@demo.com', role: 'recruiter_admin' as const, portalType: 'recruiter' as const },
  { name: 'Sam Staff', email: 'staff@demo.com', role: 'recruited_staff' as const, portalType: 'recruiter' as const },
  { name: 'Olivia Org Admin', email: 'orgadmin@demo.com', role: 'org_admin' as const, portalType: 'org' as const },
  { name: 'Owen Org Staff', email: 'orgstaff@demo.com', role: 'org_staff' as const, portalType: 'org' as const },
];

const DEFAULT_CLIENT_STAGES = [
  { name: 'Candidate applies', orderIndex: 0, stageType: 'application' as const },
  { name: 'Email notification', orderIndex: 1, stageType: 'application' as const },
  { name: 'Technical round', orderIndex: 2, stageType: 'interview' as const },
  { name: 'Management round', orderIndex: 3, stageType: 'interview' as const },
  { name: 'Offer letter', orderIndex: 4, stageType: 'application' as const },
  { name: 'Job closed', orderIndex: 5, stageType: 'application' as const },
];

const TAG_COLORS = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#14b8a6'];
const SKILL_POOL = [
  'React', 'TypeScript', 'Node.js', 'Python', 'AWS', 'Docker', 'SQL', 'GraphQL',
  'Java', 'Figma', 'Kubernetes', 'Go', 'Vue', 'Tailwind', 'PostgreSQL', 'Redis',
];
const JOB_STATUSES = ['new', 'draft', 'ready', 'submission_in_progress', 'closed'] as const;
const JOB_TYPES = ['Full-time', 'Part-time', 'Contract'] as const;
const JOB_LOCATIONS = ['Remote', 'On-site', 'Hybrid'] as const;
const CANDIDATE_STATUSES = ['New', 'In Review', 'Shortlisted', 'Interview', 'Rejected', 'Offer'] as const;
const CANDIDATE_SOURCES = ['Internal', 'LinkedIn', 'Referral', 'Job Board', 'Agency'] as const;

function envInt(key: string, fallback: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function pick<T>(arr: readonly T[]): T {
  return faker.helpers.arrayElement(arr);
}

function uniquePairs(count: number, jobIds: number[], candidateIds: number[]) {
  const pairs: { jobId: number; candidateId: number }[] = [];
  const seen = new Set<string>();
  const max = jobIds.length * candidateIds.length;
  const target = Math.min(count, max);
  let guard = 0;
  while (pairs.length < target && guard < target * 20) {
    guard += 1;
    const jobId = pick(jobIds);
    const candidateId = pick(candidateIds);
    const key = `${jobId}:${candidateId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ jobId, candidateId });
  }
  return pairs;
}

async function seedFakerFull() {
  const force = process.env.SEED_FORCE === '1';
  const existing = await db.select().from(users).where(eq(users.email, DEMO_USERS[0].email)).limit(1);
  if (existing.length > 0 && !force) {
    console.log('✅ Demo data already exists. Run npm run db:demo to reset and re-seed.');
    console.log('   Or: SEED_FORCE=1 npm run db:seed:full');
    return;
  }

  const accountCount = envInt('SEED_ACCOUNTS', 30);
  const jobCount = envInt('SEED_JOBS', 50);
  const candidateCount = envInt('SEED_CANDIDATES', 120);
  const applicationCount = envInt('SEED_APPLICATIONS', 100);
  const tagCount = envInt('SEED_TAGS', 20);
  const integrationCount = envInt('SEED_INTEGRATIONS', 6);
  const groupCount = envInt('SEED_GROUPS', 5);
  const extraTeamCount = envInt('SEED_TEAM_EXTRAS', 8);

  faker.seed(2026);
  console.log('🌱 Seeding full faker dataset for local QA…');
  console.log(`   accounts=${accountCount} jobs=${jobCount} candidates=${candidateCount} applications=${applicationCount}`);

  const hashedPassword = await bcrypt.hash(DEMO_PASSWORD, 10);
  const now = () => new Date().toISOString();

  /* ── Organization ── */
  const [org] = await db.insert(organizations).values({
    name: 'Demo Recruitment Co.',
    logo: '',
    defaults: JSON.stringify({
      defaultJobType: 'Full-time',
      defaultLocation: 'Remote',
      notifyOnApplication: true,
    }),
  }).returning();

  /* ── Core portal logins + extra team (incl. pending invites) ── */
  const teamRows = [];
  for (const demoUser of DEMO_USERS) {
    const [row] = await db.insert(users).values({
      name: demoUser.name,
      email: demoUser.email,
      password: hashedPassword,
      isVerified: 1,
      role: demoUser.role,
      portalType: demoUser.portalType,
      organizationId: org.id,
      country: 'india',
      timezone: 'ist',
      bio: faker.person.bio(),
      isActive: 1,
    }).returning();
    teamRows.push(row);
  }

  const admin = teamRows[0];
  const userId = admin.id;
  const orgId = org.id;

  for (let i = 0; i < extraTeamCount; i++) {
    const pending = i < 3;
    const [row] = await db.insert(users).values({
      name: faker.person.fullName(),
      email: faker.internet.email({ provider: 'demo.hrms.local' }),
      password: pending ? null : hashedPassword,
      isVerified: pending ? 0 : 1,
      role: pick(['recruited_staff', 'recruiter_admin', 'org_staff'] as const),
      portalType: 'recruiter',
      organizationId: orgId,
      isActive: 1,
    }).returning();
    teamRows.push(row);
  }

  /* ── Org settings ── */
  await db.insert(orgSettings).values({
    organizationId: orgId,
    website: 'https://demo-recruitment.hrms.local',
    description: faker.company.catchPhrase(),
    contactPhone: faker.phone.number(),
    contactEmail: 'hello@demo-recruitment.hrms.local',
    country: 'India',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    updatedBy: userId,
    updatedAt: now(),
  }).onConflictDoNothing();

  await db.insert(rolesPermissions).values([
    {
      organizationId: orgId,
      type: 'team',
      name: 'Recruiting team',
      description: 'Default recruiting permissions',
      permissionsJson: JSON.stringify({ jobs: true, candidates: true, clients: true }),
      membersJson: JSON.stringify(teamRows.slice(0, 4).map((u) => u.id)),
      createdBy: userId,
    },
    {
      organizationId: orgId,
      type: 'report_access',
      name: 'Pipeline reports',
      description: 'Access to saved pipeline reports',
      reportIdsJson: JSON.stringify([1, 2]),
      createdBy: userId,
    },
  ]);

  /* ── Accounts + contacts + stage templates ── */
  const accountIds: number[] = [];
  for (let i = 0; i < accountCount; i++) {
    const [account] = await db.insert(accounts).values({
      name: faker.company.name(),
      status: pick(['active', 'active', 'active', 'inactive', 'on_hold']),
      type: pick(['client', 'client', 'prospect', 'vendor']),
      website: faker.internet.url(),
      description: faker.company.catchPhrase(),
      phone: faker.phone.number(),
      email: faker.internet.email(),
      address: faker.location.streetAddress(),
      city: faker.location.city(),
      state: faker.location.state(),
      country: faker.location.country(),
      organizationId: orgId,
      createdBy: userId,
      updatedAt: now(),
    }).returning();
    accountIds.push(account.id);

    for (const stage of DEFAULT_CLIENT_STAGES) {
      await db.insert(accountStageTemplates).values({
        accountId: account.id,
        name: stage.name,
        orderIndex: stage.orderIndex,
        stageType: stage.stageType,
      });
    }

    const contactN = faker.number.int({ min: 1, max: 3 });
    for (let c = 0; c < contactN; c++) {
      await db.insert(contacts).values({
        accountId: account.id,
        firstName: faker.person.firstName(),
        lastName: faker.person.lastName(),
        email: faker.internet.email(),
        phone: faker.phone.number(),
        jobTitle: faker.person.jobTitle(),
        department: faker.commerce.department(),
        status: 'active',
        organizationId: orgId,
        createdBy: userId,
        updatedAt: now(),
      });
    }
  }

  /* ── Jobs (with per-job stages) ── */
  const jobIds: number[] = [];
  for (let i = 0; i < jobCount; i++) {
    const accountId = pick(accountIds);
    const [job] = await db.insert(jobs).values({
      title: faker.person.jobTitle(),
      department: faker.commerce.department(),
      status: pick(JOB_STATUSES),
      type: pick(JOB_TYPES),
      location: pick(JOB_LOCATIONS),
      applicants: faker.number.int({ min: 0, max: 40 }),
      description: faker.lorem.paragraphs({ min: 1, max: 2 }),
      accountId,
      payPackageMin: faker.number.float({ min: 8, max: 25, fractionDigits: 1 }),
      payPackageMax: faker.number.float({ min: 26, max: 55, fractionDigits: 1 }),
      payCurrency: pick(['INR', 'USD', 'EUR']),
      createdBy: userId,
    }).returning();
    jobIds.push(job.id);
    await copyAccountStageTemplatesToJob(accountId, job.id);
  }

  /* ── Candidates ── */
  const candidateIds: number[] = [];
  for (let i = 0; i < candidateCount; i++) {
    const skills = faker.helpers.arrayElements(SKILL_POOL, { min: 2, max: 6 });
    const fullName = faker.person.fullName();
    const [row] = await db.insert(candidates).values({
      filename: faker.system.commonFileName('pdf'),
      name: fullName,
      email: faker.internet.email({ firstName: fullName.split(' ')[0] }),
      phone: faker.phone.number(),
      location: `${faker.location.city()}, ${faker.location.country()}`,
      education: pick(['B.Tech', 'M.Tech', 'B.Sc', 'MBA', 'BCA']),
      experience: `${faker.number.int({ min: 1, max: 15 })} years`,
      skills: JSON.stringify(skills),
      matchScore: faker.number.float({ min: 55, max: 99, fractionDigits: 1 }),
      status: pick(CANDIDATE_STATUSES),
      source: pick(CANDIDATE_SOURCES),
      linkedin: faker.internet.url(),
      github: faker.internet.url(),
      portfolio: faker.internet.url(),
      summary: faker.lorem.paragraph(),
      university: faker.company.name() + ' University',
      gradYear: String(faker.number.int({ min: 2010, max: 2024 })),
      jobId: faker.helpers.maybe(() => pick(jobIds), { probability: 0.3 }) ?? null,
      createdBy: userId,
    }).returning();
    candidateIds.push(row.id);
  }

  /* ── Tags ── */
  const tagIds: number[] = [];
  for (let i = 0; i < tagCount; i++) {
    const [tag] = await db.insert(tags).values({
      organizationId: orgId,
      name: faker.helpers.arrayElement([
        'Priority', 'Remote', 'Senior', 'Junior', 'React', 'Python', 'Referral',
        'Hot', 'Bench', 'Client-ready', 'Needs visa', 'Urgent',
      ]) + (i > 11 ? ` ${i}` : ''),
      color: pick(TAG_COLORS),
      createdBy: userId,
    }).returning();
    tagIds.push(tag.id);
  }

  /* ── Applications + history + tags ── */
  const appPairs = uniquePairs(applicationCount, jobIds, candidateIds);
  const applicationIds: number[] = [];
  for (const pair of appPairs) {
    const status = pick(APP_STATUSES);
    const [app] = await db.insert(applications).values({
      jobId: pair.jobId,
      candidateId: pair.candidateId,
      status,
      notes: faker.lorem.sentence(),
      assignedTo: pick(teamRows).id,
      createdBy: userId,
    }).returning();
    applicationIds.push(app.id);

    const historySteps: AppStatus[] = ['applied', status];
    if (status !== 'applied') {
      historySteps.splice(1, 0, pick(['in_review', 'shortlisted'] as AppStatus[]));
    }
    let from: string | null = null;
    for (const to of historySteps) {
      await db.insert(applicationStageHistory).values({
        applicationId: app.id,
        fromStatus: from,
        toStatus: to,
        note: from ? `Moved to ${to}` : 'Application created',
        changedBy: userId,
      });
      from = to;
    }

    if (tagIds.length > 0 && faker.datatype.boolean({ probability: 0.4 })) {
      const tagId = pick(tagIds);
      await db.insert(applicationTags).values({ applicationId: app.id, tagId }).onConflictDoNothing();
      await db.insert(candidateTags).values({ candidateId: pair.candidateId, tagId }).onConflictDoNothing();
    }
  }

  /* ── Integrations ── */
  for (let i = 0; i < integrationCount; i++) {
    const platform = INTEGRATION_PLATFORMS[i % INTEGRATION_PLATFORMS.length];
    await db.insert(integrations).values({
      organizationId: orgId,
      platform,
      label: `${platform} — ${faker.company.name()}`,
      apiKey: `demo_${faker.string.alphanumeric(24)}`,
      configJson: JSON.stringify({ env: 'demo', region: faker.location.countryCode() }),
      isActive: 1,
      createdBy: userId,
      updatedAt: now(),
    });
  }

  /* ── Candidate groups ── */
  for (let g = 0; g < groupCount; g++) {
    const [group] = await db.insert(candidateGroups).values({
      organizationId: orgId,
      name: faker.helpers.arrayElement([
        'Senior React engineers', 'Design pipeline', 'Backend shortlist',
        'Offer stage', 'Referral pool', 'Q1 hiring',
      ]) + (g > 5 ? ` ${g}` : ''),
      description: faker.lorem.sentence(),
      createdBy: userId,
    }).returning();

    const members = faker.helpers.arrayElements(candidateIds, { min: 3, max: 12 });
    for (const candidateId of members) {
      await db.insert(candidateGroupMembers).values({ groupId: group.id, candidateId }).onConflictDoNothing();
    }
  }

  /* ── Notifications ── */
  for (const member of teamRows.slice(0, 5)) {
    for (let n = 0; n < 6; n++) {
      await db.insert(notifications).values({
        userId: member.id,
        title: faker.helpers.arrayElement([
          'New application received',
          'Interview scheduled',
          'Offer approved',
          'Client feedback pending',
          'Tag added to candidate',
        ]),
        body: faker.lorem.sentence(),
        type: pick(['info', 'success', 'warning']),
        isRead: faker.datatype.boolean({ probability: 0.35 }) ? 1 : 0,
        relatedType: pick(['application', 'job', 'candidate']),
        relatedId: pick(applicationIds.length ? applicationIds : jobIds),
      });
    }
  }

  /* ── Tasks ── */
  for (let t = 0; t < 20; t++) {
    await db.insert(tasks).values({
      taskCode: `TSK-${String(t + 1).padStart(4, '0')}`,
      title: faker.lorem.words({ min: 3, max: 6 }),
      description: faker.lorem.sentence(),
      priority: pick(['high', 'medium', 'low']),
      status: pick(['pending', 'in_progress', 'completed']),
      category: pick(['general', 'follow_up', 'interview', 'screening', 'client_call', 'submission']),
      dueDate: faker.date.soon({ days: 14 }).toISOString(),
      assignedTo: pick(teamRows).id,
      candidateId: pick(candidateIds),
      jobId: pick(jobIds),
      organizationId: orgId,
      createdBy: userId,
      updatedAt: now(),
    });
  }

  /* ── Campaigns ── */
  for (let c = 0; c < 8; c++) {
    await db.insert(campaigns).values({
      name: faker.company.catchPhrase(),
      type: pick(['hotlist', 'job_campaign']),
      status: pick(['draft', 'scheduled', 'sent']),
      subject: faker.lorem.sentence(),
      body: faker.lorem.paragraph(),
      recipientsJson: JSON.stringify(candidateIds.slice(0, 5).map(String)),
      recipientCount: 5,
      organizationId: orgId,
      createdBy: userId,
      updatedAt: now(),
    });
  }

  /* ── Calendar events ── */
  for (let e = 0; e < 15; e++) {
    const start = faker.date.soon({ days: 21 });
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    await db.insert(calendarEvents).values({
      title: faker.helpers.arrayElement(['Interview', 'Client call', 'Team sync', 'Offer review']),
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      color: pick(['blue', 'green', 'purple', 'orange']),
      eventType: pick(['interview', 'meeting', 'general']),
      candidateId: pick(candidateIds),
      candidateName: faker.person.fullName(),
      jobId: pick(jobIds),
      jobProfile: faker.person.jobTitle(),
      location: faker.location.city(),
      organizationId: orgId,
      createdBy: userId,
    });
  }

  /* ── Submissions + interviews (subset of applications) ── */
  const offerApps = applicationIds.slice(0, Math.min(12, applicationIds.length));
  for (const appId of offerApps) {
    const app = await db.select().from(applications).where(eq(applications.id, appId)).limit(1);
    if (!app.length) continue;
    const a = app[0];
    const [sub] = await db.insert(submissions).values({
      applicationId: a.id,
      jobId: a.jobId,
      candidateId: a.candidateId,
      status: pick(['internal_submitted', 'client_review', 'client_accepted']),
      clientName: faker.company.name(),
      organizationId: orgId,
      submittedBy: userId,
    }).returning();

    const start = faker.date.soon({ days: 10 });
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    await db.insert(interviews).values({
      applicationId: a.id,
      submissionId: sub.id,
      jobId: a.jobId,
      candidateId: a.candidateId,
      title: 'Technical interview',
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      status: pick(['scheduled', 'completed', 'cancelled', 'no_show']),
      accountName: faker.company.name(),
      organizationId: orgId,
      createdBy: userId,
      updatedAt: now(),
    });
  }

  /* ── Saved reports + job shortlists ── */
  await db.insert(savedReports).values([
    {
      userId,
      name: 'Pipeline overview',
      type: 'pipeline',
      filters: JSON.stringify({ status: 'in_review' }),
    },
    {
      userId,
      name: 'Offers this month',
      type: 'offers',
      filters: JSON.stringify({ status: 'offer' }),
    },
  ]);

  for (let s = 0; s < 15; s++) {
    await db.insert(jobShortlists).values({
      jobId: pick(jobIds),
      candidateId: pick(candidateIds),
      source: pick(['internal', 'linkedin', 'github', 'manual']),
      notes: faker.lorem.sentence(),
      createdBy: userId,
    }).onConflictDoNothing();
  }

  console.log('\n✅ Full faker seed complete!\n');
  console.log('┌─────────────────────┬────────────────────────┬──────────────────┬────────────┐');
  console.log('│ Portal              │ Email                  │ Role             │ Password   │');
  console.log('├─────────────────────┼────────────────────────┼──────────────────┼────────────┤');
  console.log('│ Recruiter           │ recruiter@demo.com     │ recruiter_admin  │ Demo@12345 │');
  console.log('│ Recruiter           │ staff@demo.com         │ recruited_staff  │ Demo@12345 │');
  console.log('│ Org / Client        │ orgadmin@demo.com      │ org_admin        │ Demo@12345 │');
  console.log('│ Org / Client        │ orgstaff@demo.com      │ org_staff        │ Demo@12345 │');
  console.log('└─────────────────────┴────────────────────────┴──────────────────┴────────────┘');
  console.log('\nCounts:');
  console.log(`   Organization : ${org.name} (id ${orgId})`);
  console.log(`   Team users   : ${teamRows.length} (incl. 3 pending invites)`);
  console.log(`   Accounts     : ${accountIds.length}`);
  console.log(`   Jobs         : ${jobIds.length}`);
  console.log(`   Candidates   : ${candidateIds.length}`);
  console.log(`   Applications : ${applicationIds.length}`);
  console.log(`   Tags         : ${tagIds.length}`);
  console.log(`   Integrations : ${integrationCount}`);
  console.log(`   Groups       : ${groupCount}`);
  console.log('\n   Start: npm run dev  (backend) + npm run dev (frontend in hrms-fe)');
}

seedFakerFull().catch((err) => {
  console.error('❌ Full seed failed:', err);
  process.exit(1);
});
