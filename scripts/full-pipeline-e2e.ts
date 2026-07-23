/**
 * Additive local E2E coverage for the multi-client recruitment pipeline.
 *
 * Run with: npm run test:e2e:pipeline
 *
 * Invite emails still go through the normal app path, but this script activates
 * users via forged verify-link tokens (same JWT the email would contain) so E2E
 * does not depend on a real mailbox.
 */
import 'dotenv/config';
import jwt from 'jsonwebtoken';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-in-production';
const PRIMARY_PASSWORD = 'Demo@12345';
const RECRUITER_EMAIL = 'recruiter@demo.com';
const RUN_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const CLIENT_COUNT = 20;
const RECRUITER_COUNT = 10;
const JOB_COUNT = 10;
const CANDIDATES_PER_JOB = 4;
const CANDIDATES_LIST_LIMIT_MS = 500;

type Result = { name: string; ok: boolean; detail?: string };
type ApiResponse = { status: number; json: unknown; text: string; elapsedMs: number };
type Session = {
  token: string;
  user: { id: number; email: string; role: string; portalType: string };
};
type Account = { id: number; name: string; email: string };
type Job = { id: number; accountId: number; client: Session };
type Stage = { id: number; name: string; stageType: string; orderIndex: number };
type Application = { id: number; jobStageId?: number | null; status: string };
type Dashboard = { stats?: { totalClients?: number; totalApplications?: number; activeJobs?: number } };

const results: Result[] = [];

function report(ok: boolean, name: string, detail?: string) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected JSON object, received ${JSON.stringify(value).slice(0, 200)}`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Expected JSON array, received ${JSON.stringify(value).slice(0, 200)}`);
  return value;
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function request(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; expected?: number | number[] } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const startedAt = performance.now();
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const elapsedMs = performance.now() - startedAt;
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (options.expected !== undefined) {
    const accepted = Array.isArray(options.expected)
      ? options.expected.includes(response.status)
      : response.status === options.expected;
    if (!accepted) {
      throw new Error(`${method} ${path} → ${response.status}; expected ${options.expected}: ${text.slice(0, 500)}`);
    }
  }
  return { status: response.status, json, text, elapsedMs };
}

async function attempt(name: string, action: () => Promise<void>) {
  try {
    await action();
    report(true, name);
  } catch (error) {
    report(false, name, errorDetail(error));
  }
}

async function login(email: string): Promise<Session> {
  const passwords = [PRIMARY_PASSWORD, 'Demo@HRMS'];
  let lastResponse: ApiResponse | undefined;
  for (const password of passwords) {
    const response = await request('POST', '/auth/login', { body: { email, password } });
    if (response.status === 200) {
      const body = asRecord(response.json);
      const user = asRecord(body.user);
      return {
        token: String(body.token),
        user: {
          id: Number(user.id),
          email: String(user.email),
          role: String(user.role),
          portalType: String(user.portalType),
        },
      };
    }
    lastResponse = response;
  }
  throw new Error(`Login failed for ${email}: ${lastResponse?.status} ${lastResponse?.text.slice(0, 300)}`);
}

function inviteToken(email: string): string {
  return jwt.sign({ email, type: 'verify' }, JWT_SECRET, { expiresIn: '1d' });
}

async function inviteAndActivate(
  recruiter: Session,
  input: { name: string; email: string; role: 'recruiter_admin' | 'recruited_staff' | 'org_admin'; accountId?: number },
): Promise<Session> {
  await request('POST', '/auth/invite', {
    token: recruiter.token,
    expected: 201,
    body: input,
  });
  // Skip waiting for mailbox — mint the same verify JWT the invite email would contain.
  const verified = await request('POST', '/auth/verify-link', {
    expected: 200,
    body: { token: inviteToken(input.email), password: PRIMARY_PASSWORD },
  });
  const body = asRecord(verified.json);
  const user = asRecord(body.user);
  return {
    token: String(body.token),
    user: {
      id: Number(user.id),
      email: String(user.email),
      role: String(user.role),
      portalType: String(user.portalType),
    },
  };
}

async function createAccounts(recruiter: Session): Promise<Account[]> {
  const accounts: Account[] = [];
  for (let index = 1; index <= CLIENT_COUNT; index += 1) {
    const email = `pipeline.client.${RUN_ID}.${index}@example.test`;
    const created = await request('POST', '/accounts', {
      token: recruiter.token,
      expected: 201,
      body: {
        name: `Pipeline E2E Client ${RUN_ID} ${index}`,
        email,
        phone: `+91-9900${String(index).padStart(6, '0')}`,
        status: 'active',
        type: 'client',
      },
    });
    const body = asRecord(created.json);
    accounts.push({ id: Number(body.id), name: String(body.name), email });
  }
  return accounts;
}

async function createRecruiterTeam(recruiter: Session) {
  const created: Session[] = [];
  for (let index = 1; index <= RECRUITER_COUNT; index += 1) {
    const role = index % 3 === 0 ? 'recruiter_admin' : 'recruited_staff';
    created.push(await inviteAndActivate(recruiter, {
      name: `Pipeline ${role} ${index}`,
      email: `pipeline.recruiter.${RUN_ID}.${index}@example.test`,
      role,
    }));
  }
  return created;
}

async function activateClientSessions(accounts: Account[]): Promise<Session[]> {
  const sessions: Session[] = [];
  for (const account of accounts) {
    const verified = await request('POST', '/auth/verify-link', {
      expected: 200,
      body: { token: inviteToken(account.email), password: PRIMARY_PASSWORD },
    });
    const body = asRecord(verified.json);
    const user = asRecord(body.user);
    sessions.push({
      token: String(body.token),
      user: {
        id: Number(user.id),
        email: String(user.email),
        role: String(user.role),
        portalType: String(user.portalType),
      },
    });
  }
  return sessions;
}

async function createJob(
  recruiter: Session,
  account: Account,
  client: Session,
  index: number,
): Promise<Job> {
  const created = await request('POST', '/jobs', {
    token: client.token,
    expected: 201,
    body: {
      title: `Pipeline E2E ${RUN_ID} Role ${index}`,
      department: index % 2 === 0 ? 'Engineering' : 'Operations',
      type: 'Full-time',
      location: index % 3 === 0 ? 'Hybrid' : 'Remote',
      description: `<p>Additive full-pipeline E2E job ${index}</p>`,
      accountId: account.id,
      status: 'draft',
    },
  });
  const job = asRecord(created.json);
  const jobId = Number(job.id);
  await request('PATCH', `/jobs/${jobId}/status`, {
    token: client.token,
    expected: 200,
    body: { status: 'submission_in_progress' },
  });
  await request('PUT', `/jobs/${jobId}`, {
    token: recruiter.token,
    expected: 200,
    body: { title: String(job.title), assignedTo: recruiter.user.id },
  });
  return { id: jobId, accountId: account.id, client };
}

async function getAndEnsureStages(job: Job): Promise<Stage[]> {
  const initial = await request('GET', `/jobs/${job.id}/stages`, { token: job.client.token, expected: 200 });
  let stages = asArray(asRecord(initial.json).data).map((item) => asRecord(item) as unknown as Stage);
  const existingTransit = stages.filter((stage) => stage.stageType === 'in_transit');
  if (existingTransit.length < 3) {
    for (const name of ['Shortlist', 'Interview', 'Hold'].slice(existingTransit.length)) {
      await request('POST', `/jobs/${job.id}/stages`, {
        token: job.client.token,
        expected: 201,
        body: { name },
      });
    }
    const refreshed = await request('GET', `/jobs/${job.id}/stages`, { token: job.client.token, expected: 200 });
    stages = asArray(asRecord(refreshed.json).data).map((item) => asRecord(item) as unknown as Stage);
  }
  if (!stages.some((stage) => stage.stageType === 'initial')
    || !stages.some((stage) => stage.stageType === 'hired')
    || !stages.some((stage) => stage.stageType === 'rejected')
    || stages.filter((stage) => stage.stageType === 'in_transit').length < 3) {
    throw new Error(`Job ${job.id} has incomplete stages: ${JSON.stringify(stages)}`);
  }
  return stages.sort((left, right) => left.orderIndex - right.orderIndex);
}

async function createCandidates(recruiter: Session, jobIndex: number): Promise<number[]> {
  const candidateIds: number[] = [];
  for (let index = 1; index <= CANDIDATES_PER_JOB; index += 1) {
    const created = await request('POST', '/candidates', {
      token: recruiter.token,
      expected: [200, 201],
      body: {
        name: `Pipeline Candidate ${RUN_ID} ${jobIndex}-${index}`,
        email: `pipeline.candidate.${RUN_ID}.${jobIndex}.${index}@example.test`,
        phone: `+91-8800${String(jobIndex * 10 + index).padStart(6, '0')}`,
        location: 'Bangalore',
        experience: '3 years',
        skills: ['TypeScript', 'Node.js'],
        status: 'Active',
        source: 'E2E',
      },
    });
    candidateIds.push(Number(asRecord(created.json).id));
  }
  return candidateIds;
}

function stageByType(stages: Stage[], type: string): Stage {
  const stage = stages.find((item) => item.stageType === type);
  if (!stage) throw new Error(`Missing ${type} stage`);
  return stage;
}

async function applyAndMoveCandidates(
  recruiter: Session,
  job: Job,
  stages: Stage[],
  candidateIds: number[],
): Promise<void> {
  const bulk = await request('POST', '/applications/bulk', {
    token: recruiter.token,
    expected: 201,
    body: { jobId: job.id, candidateIds, assignedTo: recruiter.user.id },
  });
  const created = asArray(asRecord(bulk.json).created).map((item) => asRecord(item) as unknown as Application);
  if (created.length !== CANDIDATES_PER_JOB) {
    throw new Error(`Expected ${CANDIDATES_PER_JOB} applications, received ${created.length}`);
  }

  const transitStages = stages.filter((stage) => stage.stageType === 'in_transit');
  const [shortlist, interview, hold] = transitStages;
  const hired = stageByType(stages, 'hired');
  const rejected = stageByType(stages, 'rejected');

  const move = (applicationId: number, jobStageId: number, note: string) => request(
    'PATCH',
    `/applications/${applicationId}/assignment`,
    { token: recruiter.token, expected: 200, body: { assignedTo: recruiter.user.id, jobStageId, note } },
  );
  const status = (applicationId: number, value: string) => request(
    'PATCH',
    `/applications/${applicationId}/status`,
    { token: recruiter.token, expected: 200, body: { status: value } },
  );

  await move(created[0].id, shortlist.id, 'Shortlisted in E2E pipeline');
  await status(created[0].id, 'in_review');
  await status(created[0].id, 'shortlisted');
  await move(created[0].id, interview.id, 'Interview stage in E2E pipeline');
  await status(created[0].id, 'interview_scheduled');
  await request('PATCH', `/applications/${created[0].id}/assignment`, {
    token: recruiter.token,
    expected: 200,
    body: { assignedTo: recruiter.user.id, jobStageId: hired.id, closeAs: 'hired', note: 'Hired in E2E pipeline' },
  });

  await move(created[1].id, shortlist.id, 'Shortlisted in E2E pipeline');
  await status(created[1].id, 'in_review');
  await status(created[1].id, 'shortlisted');
  await move(created[1].id, interview.id, 'Interview stage in E2E pipeline');
  await status(created[1].id, 'interview_scheduled');
  await move(created[1].id, hold.id, 'Held in E2E pipeline');
  await status(created[1].id, 'hold');

  await move(created[2].id, shortlist.id, 'Rejected after shortlist in E2E pipeline');
  await request('PATCH', `/applications/${created[2].id}/assignment`, {
    token: recruiter.token,
    expected: 200,
    body: { assignedTo: recruiter.user.id, jobStageId: rejected.id, closeAs: 'rejected', note: 'Rejected in E2E pipeline' },
  });

  await move(created[3].id, shortlist.id, 'Shortlisted candidate remains open');
  await status(created[3].id, 'in_review');
  await status(created[3].id, 'shortlisted');
}

async function assertPipelineCounts(recruiter: Session, job: Job, expectedApplications: number) {
  const [statsResponse, overviewResponse] = await Promise.all([
    request('GET', `/jobs/${job.id}/stage-stats`, { token: recruiter.token, expected: 200 }),
    request('GET', `/jobs/${job.id}/overview`, { token: recruiter.token, expected: 200 }),
  ]);
  const stats = asRecord(statsResponse.json);
  const stageRows = asArray(stats.data).map((row) => asRecord(row));
  const total = Number(stats.totalApplications);
  const assigned = stageRows.reduce((sum, row) => sum + Number(row.count ?? 0), 0);
  const overview = asRecord(overviewResponse.json);
  const summary = asRecord(overview.pipelineSummary);
  if (total !== expectedApplications || assigned !== expectedApplications) {
    throw new Error(`Stage stats total=${total}, stage sum=${assigned}, expected=${expectedApplications}`);
  }
  if (Number(summary.rejected) < 1 || Number(summary.onboarded) < 1) {
    throw new Error(`Overview did not reflect terminal moves: ${JSON.stringify(summary)}`);
  }
}

async function assertPortalIsolation(
  recruiter: Session,
  first: { account: Account; client: Session; job: Job },
  second: { account: Account; client: Session; job: Job },
) {
  const firstJobs = asArray((await request('GET', '/jobs', { token: first.client.token, expected: 200 })).json)
    .map((row) => asRecord(row));
  const secondJobs = asArray((await request('GET', '/jobs', { token: second.client.token, expected: 200 })).json)
    .map((row) => asRecord(row));
  if (!firstJobs.some((job) => Number(job.id) === first.job.id)
    || firstJobs.some((job) => Number(job.id) === second.job.id)
    || !secondJobs.some((job) => Number(job.id) === second.job.id)
    || secondJobs.some((job) => Number(job.id) === first.job.id)) {
    throw new Error('Client job list leaked across accounts');
  }
  await request('GET', `/jobs/${second.job.id}`, { token: first.client.token, expected: [403, 404] });

  const eventTime = { startTime: '2030-01-01T09:00:00.000Z', endTime: '2030-01-01T10:00:00.000Z' };
  const firstTitle = `Pipeline A private ${RUN_ID}`;
  const secondTitle = `Pipeline B private ${RUN_ID}`;
  const recruiterTitle = `Pipeline recruiter private ${RUN_ID}`;
  await request('POST', '/calendar', { token: first.client.token, expected: 201, body: { ...eventTime, title: firstTitle } });
  await request('POST', '/calendar', { token: second.client.token, expected: 201, body: { ...eventTime, title: secondTitle } });
  await request('POST', '/calendar', { token: recruiter.token, expected: 201, body: { ...eventTime, title: recruiterTitle } });
  const [firstCalendar, secondCalendar] = await Promise.all([
    request('GET', '/calendar', { token: first.client.token, expected: 200 }),
    request('GET', '/calendar', { token: second.client.token, expected: 200 }),
  ]);
  const titles = (response: ApiResponse) => asArray(response.json).map((event) => String(asRecord(event).title));
  const firstTitles = titles(firstCalendar);
  const secondTitles = titles(secondCalendar);
  if (!firstTitles.includes(firstTitle) || firstTitles.includes(secondTitle) || firstTitles.includes(recruiterTitle)
    || !secondTitles.includes(secondTitle) || secondTitles.includes(firstTitle) || secondTitles.includes(recruiterTitle)) {
    throw new Error(`Calendar events leaked: A=${JSON.stringify(firstTitles)} B=${JSON.stringify(secondTitles)}`);
  }
}

async function measureEndpoint(name: string, path: string, token: string, maximumMs?: number) {
  const response = await request('GET', path, { token, expected: 200 });
  const rounded = Math.round(response.elapsedMs);
  console.log(`  ⏱ ${name}: ${rounded}ms`);
  if (maximumMs !== undefined && response.elapsedMs > maximumMs) {
    throw new Error(`${name} took ${rounded}ms (limit ${maximumMs}ms)`);
  }
}

async function run() {
  console.log(`Full pipeline E2E against ${BASE_URL} (run ${RUN_ID})`);
  await request('GET', '/', { expected: 200 });
  const recruiter = await login(RECRUITER_EMAIL);
  report(true, 'Recruiter login', `${recruiter.user.email} (${recruiter.user.role})`);

  let accounts: Account[] = [];
  let team: Session[] = [];
  let clientSessions: Session[] = [];
  const jobs: Job[] = [];

  await attempt(`Create ${CLIENT_COUNT} additive clients`, async () => {
    accounts = await createAccounts(recruiter);
    if (accounts.length !== CLIENT_COUNT) throw new Error(`Created ${accounts.length}/${CLIENT_COUNT} clients`);
  });
  if (accounts.length !== CLIENT_COUNT) return;

  await attempt(`Create ${RECRUITER_COUNT} recruiter users through invite API`, async () => {
    team = await createRecruiterTeam(recruiter);
    const admins = team.filter((user) => user.user.role === 'recruiter_admin').length;
    const staff = team.filter((user) => user.user.role === 'recruited_staff').length;
    if (admins === 0 || staff === 0) throw new Error(`Expected mixed roles; admins=${admins}, staff=${staff}`);
  });

  await attempt('Activate client portal users', async () => {
    clientSessions = await activateClientSessions(accounts.slice(0, JOB_COUNT));
    if (clientSessions.length < 2) throw new Error('Need at least two client portal users');
  });
  if (clientSessions.length !== JOB_COUNT) return;

  await attempt(`Create ${JOB_COUNT} client-posted jobs with stages`, async () => {
    for (let index = 0; index < JOB_COUNT; index += 1) {
      const job = await createJob(recruiter, accounts[index], clientSessions[index], index + 1);
      await getAndEnsureStages(job);
      jobs.push(job);
    }
  });
  if (jobs.length !== JOB_COUNT) return;

  await attempt(`Create, apply, and move ${JOB_COUNT * CANDIDATES_PER_JOB} applications`, async () => {
    for (let index = 0; index < jobs.length; index += 1) {
      const stages = await getAndEnsureStages(jobs[index]);
      const candidateIds = await createCandidates(recruiter, index + 1);
      await applyAndMoveCandidates(recruiter, jobs[index], stages, candidateIds);
      await assertPipelineCounts(recruiter, jobs[index], CANDIDATES_PER_JOB);
    }
  });

  await attempt('Assert dashboard pipeline counts update', async () => {
    const dashboard = asRecord((await request('GET', '/dashboard', { token: recruiter.token, expected: 200 })).json) as Dashboard;
    const stats = dashboard.stats;
    if (!stats || Number(stats.totalClients) < CLIENT_COUNT || Number(stats.activeJobs) < JOB_COUNT
      || Number(stats.totalApplications) < JOB_COUNT * CANDIDATES_PER_JOB) {
      throw new Error(`Dashboard counts insufficient: ${JSON.stringify(stats)}`);
    }
  });

  await attempt('Assert two-client job and calendar isolation', async () => {
    await assertPortalIsolation(recruiter, {
      account: accounts[0], client: clientSessions[0], job: jobs[0],
    }, {
      account: accounts[1], client: clientSessions[1], job: jobs[1],
    });
  });

  await attempt('Measure candidates, jobs, and dashboard endpoints', async () => {
    await measureEndpoint('GET /candidates?page=1', '/candidates?page=1&pageSize=25', recruiter.token, CANDIDATES_LIST_LIMIT_MS);
    await measureEndpoint('GET /jobs', '/jobs', recruiter.token);
    await measureEndpoint('GET /dashboard', '/dashboard', recruiter.token);
  });
}

async function main() {
  try {
    await run();
  } catch (error) {
    report(false, 'Pipeline setup', errorDetail(error));
  }

  const passed = results.filter((result) => result.ok).length;
  const failed = results.filter((result) => !result.ok);
  console.log('\n════════ PIPELINE E2E SUMMARY ════════');
  console.log(`PASS ${passed}  FAIL ${failed.length}  TOTAL ${results.length}`);
  for (const result of failed) {
    console.log(`  - ${result.name}: ${result.detail ?? 'unknown failure'}`);
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}

void main();
