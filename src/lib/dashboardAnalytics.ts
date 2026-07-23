import { and, eq, gte, inArray, isNull, lt, or, sql, desc, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  accounts,
  applications,
  campaigns,
  candidates,
  interviews,
  jobs,
  jobStages,
  rolesPermissions,
  submissions,
  users,
} from '../db/schema.js';

export type MetricKey =
  | 'jobs'
  | 'candidates'
  | 'submissions'
  | 'endClientSubmissions'
  | 'interviews'
  | 'confirmations'
  | 'offers'
  | 'placements'
  | 'dropouts'
  | 'deferred'
  | 'poolAdded'
  | 'activePool'
  | 'poolNoSubmissions'
  | 'poolWithSubmissions'
  | 'poolPlaced'
  | 'hotlist'
  | 'poolInterviews';

export type MetricStat = { count: number; delta: number; momPct: number };

export type AnalyticsFilters = {
  fromStart: string;
  toExclusive: string;
  userIds: number[];
  accountIds: number[] | null; // null = all accessible
  memberIds: number[];
};

const OPEN_JOB_STATUSES = ['new', 'ready', 'submission_in_progress', 'on_hold'] as const;
const END_CLIENT_STATUSES = [
  'client_review',
  'client_interview_scheduled',
  'client_rejected',
  'client_accepted',
] as const;

function emptyStat(): MetricStat {
  return { count: 0, delta: 0, momPct: 0 };
}

export function withMom(current: number, previous: number): MetricStat {
  const delta = current - previous;
  let momPct = 0;
  if (previous === 0) {
    momPct = current === 0 ? 0 : 100;
  } else {
    momPct = Math.round((delta / previous) * 10000) / 100;
  }
  return { count: current, delta, momPct };
}

/** Parse YYYY-MM-DD; `to` is inclusive calendar day. */
export function parseDateRange(fromRaw: string | undefined, toRaw: string | undefined): {
  fromStart: string;
  toExclusive: string;
  prevFromStart: string;
  prevToExclusive: string;
} {
  const today = new Date();
  const y = today.getFullYear();
  const m = String(today.getMonth() + 1).padStart(2, '0');
  const defaultFrom = `${y}-${m}-01`;
  const defaultTo = today.toISOString().slice(0, 10);

  const fromStart = (fromRaw && /^\d{4}-\d{2}-\d{2}/.test(fromRaw) ? fromRaw : defaultFrom).slice(0, 10);
  const toDay = (toRaw && /^\d{4}-\d{2}-\d{2}/.test(toRaw) ? toRaw : defaultTo).slice(0, 10);
  const toExclusive = addDays(toDay, 1);

  const days = daysBetween(fromStart, toExclusive);
  const prevToExclusive = fromStart;
  const prevFromStart = addDays(fromStart, -days);

  return { fromStart, toExclusive, prevFromStart, prevToExclusive };
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromStart: string, toExclusive: string): number {
  const a = new Date(`${fromStart}T00:00:00.000Z`).getTime();
  const b = new Date(`${toExclusive}T00:00:00.000Z`).getTime();
  return Math.max(1, Math.round((b - a) / 86400000));
}

export function parseIdList(raw: string | undefined, allowed: number[]): number[] {
  if (!raw?.trim()) return [...allowed];
  const ids = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && allowed.includes(n));
  return ids.length > 0 ? ids : [...allowed];
}

export function parseOptionalAccountIds(
  raw: string | undefined,
  accessible: number[],
): number[] | null {
  if (!raw?.trim()) return null;
  const ids = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && accessible.includes(n));
  return ids;
}

function inUserIds(column: any, userIds: number[]): SQL | undefined {
  if (userIds.length === 0) return sql`false`;
  if (userIds.length === 1) return eq(column, userIds[0]!);
  return inArray(column, userIds);
}

async function resolveJobIdsForAccounts(accountIds: number[] | null, memberIds: number[]): Promise<number[] | null> {
  if (accountIds == null) return null;
  if (accountIds.length === 0) return [];

  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        inArray(jobs.accountId, accountIds),
        memberIds.length === 1
          ? or(eq(jobs.createdBy, memberIds[0]!), eq(jobs.assignedTo, memberIds[0]!))
          : or(inArray(jobs.createdBy, memberIds), inArray(jobs.assignedTo, memberIds)),
      ),
    );
  return rows.map((r) => r.id);
}

function dateInRange(column: any, fromStart: string, toExclusive: string): SQL {
  return and(gte(column, fromStart), lt(column, toExclusive))!;
}

async function countJobs(filters: AnalyticsFilters): Promise<number> {
  const userScope = inUserIds(jobs.createdBy, filters.userIds);
  const accountScope =
    filters.accountIds == null
      ? undefined
      : filters.accountIds.length === 0
        ? sql`false`
        : inArray(jobs.accountId, filters.accountIds);

  const rows = await db
    .select({ cnt: sql<number>`count(*)` })
    .from(jobs)
    .where(and(dateInRange(jobs.postedDate, filters.fromStart, filters.toExclusive), userScope, accountScope));
  return Number(rows[0]?.cnt ?? 0);
}

async function countCandidates(filters: AnalyticsFilters, poolOnly = false): Promise<number> {
  const userScope = inUserIds(candidates.createdBy, filters.userIds);
  const pool = poolOnly ? isNull(candidates.jobId) : undefined;
  const rows = await db
    .select({ cnt: sql<number>`count(*)` })
    .from(candidates)
    .where(and(dateInRange(candidates.createdAt, filters.fromStart, filters.toExclusive), userScope, pool));
  return Number(rows[0]?.cnt ?? 0);
}

async function countActivePool(filters: AnalyticsFilters): Promise<number> {
  const userScope = inUserIds(candidates.createdBy, filters.userIds);
  const rows = await db
    .select({ cnt: sql<number>`count(*)` })
    .from(candidates)
    .where(and(isNull(candidates.jobId), userScope));
  return Number(rows[0]?.cnt ?? 0);
}

async function countSubmissions(
  filters: AnalyticsFilters,
  statusFilter?: readonly string[] | 'end_client',
): Promise<number> {
  const jobIds = await resolveJobIdsForAccounts(filters.accountIds, filters.memberIds);
  if (jobIds && jobIds.length === 0) return 0;

  const userScope = inUserIds(submissions.submittedBy, filters.userIds);
  const statusScope =
    statusFilter === 'end_client'
      ? inArray(submissions.status, [...END_CLIENT_STATUSES])
      : statusFilter
        ? inArray(submissions.status, statusFilter as typeof END_CLIENT_STATUSES[number][])
        : undefined;

  const rows = await db
    .select({ cnt: sql<number>`count(*)` })
    .from(submissions)
    .where(
      and(
        dateInRange(submissions.submittedAt, filters.fromStart, filters.toExclusive),
        userScope,
        statusScope,
        jobIds ? inArray(submissions.jobId, jobIds) : undefined,
      ),
    );
  return Number(rows[0]?.cnt ?? 0);
}

async function countInterviews(filters: AnalyticsFilters, poolOnly = false): Promise<number> {
  const jobIds = await resolveJobIdsForAccounts(filters.accountIds, filters.memberIds);
  if (jobIds && jobIds.length === 0) return 0;

  const userScope = inUserIds(interviews.createdBy, filters.userIds);
  const conditions: (SQL | undefined)[] = [
    dateInRange(interviews.startTime, filters.fromStart, filters.toExclusive),
    userScope,
    jobIds ? inArray(interviews.jobId, jobIds) : undefined,
  ];

  if (poolOnly) {
    const rows = await db
      .select({ cnt: sql<number>`count(*)` })
      .from(interviews)
      .innerJoin(candidates, eq(interviews.candidateId, candidates.id))
      .where(and(...conditions, isNull(candidates.jobId)));
    return Number(rows[0]?.cnt ?? 0);
  }

  const rows = await db
    .select({ cnt: sql<number>`count(*)` })
    .from(interviews)
    .where(and(...conditions));
  return Number(rows[0]?.cnt ?? 0);
}

async function countOffers(filters: AnalyticsFilters): Promise<number> {
  const jobIds = await resolveJobIdsForAccounts(filters.accountIds, filters.memberIds);
  if (jobIds && jobIds.length === 0) return 0;

  const userScope = inUserIds(applications.createdBy, filters.userIds);
  const rows = await db
    .select({ cnt: sql<number>`count(*)` })
    .from(applications)
    .where(
      and(
        eq(applications.status, 'offer'),
        dateInRange(applications.updatedAt, filters.fromStart, filters.toExclusive),
        userScope,
        jobIds ? inArray(applications.jobId, jobIds) : undefined,
      ),
    );
  return Number(rows[0]?.cnt ?? 0);
}

async function countPlacements(filters: AnalyticsFilters): Promise<number> {
  const jobIds = await resolveJobIdsForAccounts(filters.accountIds, filters.memberIds);
  if (jobIds && jobIds.length === 0) return 0;

  const userScope = inUserIds(applications.createdBy, filters.userIds);
  const rows = await db
    .select({ cnt: sql<number>`count(distinct ${applications.id})` })
    .from(applications)
    .innerJoin(jobStages, eq(applications.jobStageId, jobStages.id))
    .where(
      and(
        eq(jobStages.stageType, 'hired'),
        dateInRange(applications.updatedAt, filters.fromStart, filters.toExclusive),
        userScope,
        jobIds ? inArray(applications.jobId, jobIds) : undefined,
      ),
    );
  return Number(rows[0]?.cnt ?? 0);
}

async function countDropouts(filters: AnalyticsFilters): Promise<number> {
  const jobIds = await resolveJobIdsForAccounts(filters.accountIds, filters.memberIds);
  if (jobIds && jobIds.length === 0) return 0;

  const appUser = inUserIds(applications.createdBy, filters.userIds);
  const subUser = inUserIds(submissions.submittedBy, filters.userIds);

  const appRows = await db
    .select({ cnt: sql<number>`count(*)` })
    .from(applications)
    .where(
      and(
        inArray(applications.status, ['no_offer', 'rejected']),
        dateInRange(applications.updatedAt, filters.fromStart, filters.toExclusive),
        appUser,
        jobIds ? inArray(applications.jobId, jobIds) : undefined,
      ),
    );

  const subRows = await db
    .select({ cnt: sql<number>`count(*)` })
    .from(submissions)
    .where(
      and(
        inArray(submissions.status, ['withdrawn', 'client_rejected']),
        dateInRange(submissions.submittedAt, filters.fromStart, filters.toExclusive),
        subUser,
        jobIds ? inArray(submissions.jobId, jobIds) : undefined,
      ),
    );

  return Number(appRows[0]?.cnt ?? 0) + Number(subRows[0]?.cnt ?? 0);
}

async function countDeferred(filters: AnalyticsFilters): Promise<number> {
  const jobIds = await resolveJobIdsForAccounts(filters.accountIds, filters.memberIds);
  if (jobIds && jobIds.length === 0) return 0;
  const userScope = inUserIds(applications.createdBy, filters.userIds);
  const rows = await db
    .select({ cnt: sql<number>`count(*)` })
    .from(applications)
    .where(
      and(
        eq(applications.status, 'hold'),
        dateInRange(applications.updatedAt, filters.fromStart, filters.toExclusive),
        userScope,
        jobIds ? inArray(applications.jobId, jobIds) : undefined,
      ),
    );
  return Number(rows[0]?.cnt ?? 0);
}

async function countPoolSubmissionSplit(filters: AnalyticsFilters): Promise<{ withSub: number; withoutSub: number }> {
  const userScope = inUserIds(candidates.createdBy, filters.userIds);
  const rows = await db
    .select({
      withSub: sql<number>`count(*) filter (where exists (
        select 1 from submissions s where s.candidate_id = ${candidates.id}
      ))`,
      withoutSub: sql<number>`count(*) filter (where not exists (
        select 1 from submissions s where s.candidate_id = ${candidates.id}
      ))`,
    })
    .from(candidates)
    .where(and(isNull(candidates.jobId), userScope));

  return {
    withSub: Number(rows[0]?.withSub ?? 0),
    withoutSub: Number(rows[0]?.withoutSub ?? 0),
  };
}

async function countPoolPlaced(filters: AnalyticsFilters): Promise<number> {
  const userScope = inUserIds(candidates.createdBy, filters.userIds);
  const rows = await db
    .select({ cnt: sql<number>`count(distinct ${candidates.id})` })
    .from(candidates)
    .innerJoin(applications, eq(applications.candidateId, candidates.id))
    .innerJoin(jobStages, eq(applications.jobStageId, jobStages.id))
    .where(
      and(
        isNull(candidates.jobId),
        eq(jobStages.stageType, 'hired'),
        userScope,
        dateInRange(applications.updatedAt, filters.fromStart, filters.toExclusive),
      ),
    );
  return Number(rows[0]?.cnt ?? 0);
}

async function countHotlist(filters: AnalyticsFilters): Promise<number> {
  const userScope = inUserIds(campaigns.createdBy, filters.userIds);
  const rows = await db
    .select({ cnt: sql<number>`count(*)` })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.type, 'hotlist'),
        dateInRange(campaigns.createdAt, filters.fromStart, filters.toExclusive),
        userScope,
      ),
    );
  return Number(rows[0]?.cnt ?? 0);
}

export async function computeMetricCount(metric: MetricKey, filters: AnalyticsFilters): Promise<number> {
  switch (metric) {
    case 'jobs':
      return countJobs(filters);
    case 'candidates':
      return countCandidates(filters);
    case 'submissions':
      return countSubmissions(filters);
    case 'endClientSubmissions':
      return countSubmissions(filters, 'end_client');
    case 'interviews':
      return countInterviews(filters);
    case 'confirmations':
      return countSubmissions(filters, ['client_accepted']);
    case 'offers':
      return countOffers(filters);
    case 'placements':
      return countPlacements(filters);
    case 'dropouts':
      return countDropouts(filters);
    case 'deferred':
      return countDeferred(filters);
    case 'poolAdded':
      return countCandidates(filters, true);
    case 'activePool':
      return countActivePool(filters);
    case 'poolNoSubmissions':
      return (await countPoolSubmissionSplit(filters)).withoutSub;
    case 'poolWithSubmissions':
      return (await countPoolSubmissionSplit(filters)).withSub;
    case 'poolPlaced':
      return countPoolPlaced(filters);
    case 'hotlist':
      return countHotlist(filters);
    case 'poolInterviews':
      return countInterviews(filters, true);
    default:
      return 0;
  }
}

export async function buildRecruitmentStats(
  current: AnalyticsFilters,
  previous: AnalyticsFilters,
): Promise<{
  jobs: MetricStat;
  candidates: MetricStat;
  submissions: MetricStat;
  endClientSubmissions: MetricStat;
  interviews: MetricStat;
  confirmations: MetricStat;
  offers: MetricStat;
  placements: MetricStat;
  dropouts: MetricStat;
}> {
  const keys = [
    'jobs',
    'candidates',
    'submissions',
    'endClientSubmissions',
    'interviews',
    'confirmations',
    'offers',
    'placements',
    'dropouts',
  ] as const;

  const pairs = await Promise.all(
    keys.map(async (key) => {
      const [cur, prev] = await Promise.all([
        computeMetricCount(key, current),
        computeMetricCount(key, previous),
      ]);
      return [key, withMom(cur, prev)] as const;
    }),
  );

  return Object.fromEntries(pairs) as {
    jobs: MetricStat;
    candidates: MetricStat;
    submissions: MetricStat;
    endClientSubmissions: MetricStat;
    interviews: MetricStat;
    confirmations: MetricStat;
    offers: MetricStat;
    placements: MetricStat;
    dropouts: MetricStat;
  };
}

export async function buildBenchSalesStats(
  current: AnalyticsFilters,
  previous: AnalyticsFilters,
): Promise<{
  poolAdded: MetricStat;
  activePool: MetricStat;
  poolNoSubmissions: MetricStat;
  poolWithSubmissions: MetricStat;
  poolPlaced: MetricStat;
  hotlist: MetricStat;
  interviews: MetricStat;
}> {
  const mapping: Array<{ out: string; key: MetricKey }> = [
    { out: 'poolAdded', key: 'poolAdded' },
    { out: 'activePool', key: 'activePool' },
    { out: 'poolNoSubmissions', key: 'poolNoSubmissions' },
    { out: 'poolWithSubmissions', key: 'poolWithSubmissions' },
    { out: 'poolPlaced', key: 'poolPlaced' },
    { out: 'hotlist', key: 'hotlist' },
    { out: 'interviews', key: 'poolInterviews' },
  ];

  const entries = await Promise.all(
    mapping.map(async ({ out, key }) => {
      const [cur, prev] = await Promise.all([
        computeMetricCount(key, current),
        key === 'activePool' || key === 'poolNoSubmissions' || key === 'poolWithSubmissions'
          ? computeMetricCount(key, current)
          : computeMetricCount(key, previous),
      ]);
      // active pool / split are point-in-time — MoM uses previous period recreate for timed metrics only
      if (key === 'activePool' || key === 'poolNoSubmissions' || key === 'poolWithSubmissions') {
        return [out, withMom(cur, 0)] as const;
      }
      return [out, withMom(cur, prev)] as const;
    }),
  );

  return Object.fromEntries(entries) as {
    poolAdded: MetricStat;
    activePool: MetricStat;
    poolNoSubmissions: MetricStat;
    poolWithSubmissions: MetricStat;
    poolPlaced: MetricStat;
    hotlist: MetricStat;
    interviews: MetricStat;
  };
}

export async function buildConversion(filters: AnalyticsFilters) {
  const [submissionsCount, interviewsCount, confirmations, placements, deferred] = await Promise.all([
    computeMetricCount('submissions', filters),
    computeMetricCount('interviews', filters),
    computeMetricCount('confirmations', filters),
    computeMetricCount('placements', filters),
    computeMetricCount('deferred', filters),
  ]);

  const pct = (num: number, den: number) => (den === 0 ? 0 : Math.round((num / den) * 100));

  return {
    submissions: submissionsCount,
    interviews: interviewsCount,
    confirmations,
    placements,
    deferred,
    rates: {
      subToInt: pct(interviewsCount, submissionsCount),
      subToConf: pct(confirmations, submissionsCount),
      intToConf: pct(confirmations, interviewsCount),
    },
  };
}

type MemberAgg = {
  id: number;
  name: string;
  kind: 'user' | 'team';
  jobs: number;
  candidates: number;
  submissions: number;
  interviews: number;
  confirmations: number;
  offers: number;
  placements: number;
  dropouts: number;
  activeJobs: number;
  positions: number;
  submissionsDone: number;
};

async function metricsForUserIds(
  base: AnalyticsFilters,
  userIds: number[],
): Promise<Omit<MemberAgg, 'id' | 'name' | 'kind'>> {
  const f: AnalyticsFilters = { ...base, userIds };
  const [
    jobsCount,
    candidatesCount,
    submissionsCount,
    interviewsCount,
    confirmations,
    offers,
    placements,
    dropouts,
  ] = await Promise.all([
    computeMetricCount('jobs', f),
    computeMetricCount('candidates', f),
    computeMetricCount('submissions', f),
    computeMetricCount('interviews', f),
    computeMetricCount('confirmations', f),
    computeMetricCount('offers', f),
    computeMetricCount('placements', f),
    computeMetricCount('dropouts', f),
  ]);

  const accountScope =
    base.accountIds == null
      ? undefined
      : base.accountIds.length === 0
        ? sql`false`
        : inArray(jobs.accountId, base.accountIds);

  const activeRows = await db
    .select({
      cnt: sql<number>`count(*)`,
      positions: sql<number>`coalesce(sum(${jobs.applicants}), 0)`,
    })
    .from(jobs)
    .where(
      and(
        inArray(jobs.status, [...OPEN_JOB_STATUSES]),
        inUserIds(jobs.createdBy, userIds),
        accountScope,
      ),
    );

  return {
    jobs: jobsCount,
    candidates: candidatesCount,
    submissions: submissionsCount,
    interviews: interviewsCount,
    confirmations,
    offers,
    placements,
    dropouts,
    activeJobs: Number(activeRows[0]?.cnt ?? 0),
    positions: Number(activeRows[0]?.positions ?? 0),
    submissionsDone: submissionsCount,
  };
}

export async function buildByMember(
  filters: AnalyticsFilters,
  groupBy: 'user' | 'team',
  orgId: number | null,
): Promise<MemberAgg[]> {
  if (groupBy === 'team') {
    if (orgId == null) return [];
    const teams = await db
      .select({
        id: rolesPermissions.id,
        name: rolesPermissions.name,
        membersJson: rolesPermissions.membersJson,
      })
      .from(rolesPermissions)
      .where(and(eq(rolesPermissions.organizationId, orgId), eq(rolesPermissions.type, 'team')));

    const result: MemberAgg[] = [];
    for (const team of teams) {
      let memberIds: number[] = [];
      try {
        const parsed = JSON.parse(team.membersJson || '[]') as unknown;
        if (Array.isArray(parsed)) {
          memberIds = parsed
            .map((x) => Number(x))
            .filter((n) => Number.isFinite(n) && filters.memberIds.includes(n));
        }
      } catch {
        memberIds = [];
      }
      if (memberIds.length === 0) {
        result.push({
          id: team.id,
          name: team.name,
          kind: 'team',
          jobs: 0,
          candidates: 0,
          submissions: 0,
          interviews: 0,
          confirmations: 0,
          offers: 0,
          placements: 0,
          dropouts: 0,
          activeJobs: 0,
          positions: 0,
          submissionsDone: 0,
        });
        continue;
      }
      const scoped = memberIds.filter((id) => filters.userIds.includes(id));
      const ids = scoped.length > 0 ? scoped : memberIds;
      const metrics = await metricsForUserIds(filters, ids);
      result.push({ id: team.id, name: team.name, kind: 'team', ...metrics });
    }
    return result;
  }

  const orgUsers = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.id, filters.userIds.length ? filters.userIds : filters.memberIds));

  return Promise.all(
    orgUsers.map(async (u) => {
      const metrics = await metricsForUserIds(filters, [u.id]);
      return { id: u.id, name: u.name, kind: 'user' as const, ...metrics };
    }),
  );
}

export async function buildPipelineSummary(filters: AnalyticsFilters) {
  const jobIds = await resolveJobIdsForAccounts(filters.accountIds, filters.memberIds);
  if (jobIds && jobIds.length === 0) {
    return {
      pipelined: 0,
      submitted: 0,
      endClient: 0,
      interviews: 0,
      confirmations: 0,
      rejected: 0,
      onboarded: 0,
    };
  }

  const userScope = inUserIds(applications.createdBy, filters.userIds);
  const appBase = and(userScope, jobIds ? inArray(applications.jobId, jobIds) : undefined);

  const [pipelined, submitted, endClient, interviewsCount, confirmations, rejected, onboarded] =
    await Promise.all([
      db
        .select({ cnt: sql<number>`count(*)` })
        .from(applications)
        .where(and(appBase, inArray(applications.status, ['applied', 'in_review', 'shortlisted'])))
        .then((r) => Number(r[0]?.cnt ?? 0)),
      computeMetricCount('submissions', { ...filters, fromStart: '1970-01-01', toExclusive: '9999-12-31' }),
      computeMetricCount('endClientSubmissions', {
        ...filters,
        fromStart: '1970-01-01',
        toExclusive: '9999-12-31',
      }),
      computeMetricCount('interviews', { ...filters, fromStart: '1970-01-01', toExclusive: '9999-12-31' }),
      computeMetricCount('confirmations', { ...filters, fromStart: '1970-01-01', toExclusive: '9999-12-31' }),
      db
        .select({ cnt: sql<number>`count(*)` })
        .from(applications)
        .where(and(appBase, inArray(applications.status, ['rejected', 'no_offer'])))
        .then((r) => Number(r[0]?.cnt ?? 0)),
      computeMetricCount('placements', { ...filters, fromStart: '1970-01-01', toExclusive: '9999-12-31' }),
    ]);

  return {
    pipelined,
    submitted,
    endClient,
    interviews: interviewsCount,
    confirmations,
    rejected,
    onboarded,
  };
}

export async function buildTodo(filters: AnalyticsFilters) {
  const jobIds = await resolveJobIdsForAccounts(filters.accountIds, filters.memberIds);
  const now = new Date().toISOString();

  const upcomingInterviews = await db
    .select({ cnt: sql<number>`count(*)` })
    .from(interviews)
    .where(
      and(
        eq(interviews.status, 'scheduled'),
        gte(interviews.startTime, now),
        inUserIds(interviews.createdBy, filters.userIds),
        jobIds ? (jobIds.length === 0 ? sql`false` : inArray(interviews.jobId, jobIds)) : undefined,
      ),
    );

  const pipeline = await db
    .select({ cnt: sql<number>`count(*)` })
    .from(applications)
    .where(
      and(
        inArray(applications.status, ['applied', 'in_review', 'shortlisted', 'interview_scheduled', 'hold']),
        inUserIds(applications.createdBy, filters.userIds),
        jobIds ? (jobIds.length === 0 ? sql`false` : inArray(applications.jobId, jobIds)) : undefined,
      ),
    );

  return {
    tasksPending: 0,
    interviewsScheduled: Number(upcomingInterviews[0]?.cnt ?? 0),
    onboardingInProgress: 0,
    candidatesInPipeline: Number(pipeline[0]?.cnt ?? 0),
  };
}

export async function buildMatchingProfiles(filters: AnalyticsFilters) {
  const userScope = inUserIds(candidates.createdBy, filters.userIds);
  const [band80, band50, band10] = await Promise.all([
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(candidates)
      .where(and(userScope, gte(candidates.matchScore, 80)))
      .then((r) => Number(r[0]?.cnt ?? 0)),
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(candidates)
      .where(and(userScope, gte(candidates.matchScore, 50)))
      .then((r) => Number(r[0]?.cnt ?? 0)),
    db
      .select({ cnt: sql<number>`count(*)` })
      .from(candidates)
      .where(and(userScope, gte(candidates.matchScore, 10)))
      .then((r) => Number(r[0]?.cnt ?? 0)),
  ]);
  return { band80, band50, band10 };
}

export async function buildActivity(filters: AnalyticsFilters, limit = 20) {
  const jobIds = await resolveJobIdsForAccounts(filters.accountIds, filters.memberIds);
  if (jobIds && jobIds.length === 0) return [];

  const subRows = await db
    .select({
      id: submissions.id,
      at: submissions.submittedAt,
      candidateName: candidates.name,
      jobTitle: jobs.title,
      actorName: users.name,
      submittedBy: submissions.submittedBy,
    })
    .from(submissions)
    .leftJoin(candidates, eq(submissions.candidateId, candidates.id))
    .leftJoin(jobs, eq(submissions.jobId, jobs.id))
    .leftJoin(users, eq(submissions.submittedBy, users.id))
    .where(
      and(
        inUserIds(submissions.submittedBy, filters.userIds),
        jobIds ? inArray(submissions.jobId, jobIds) : undefined,
      ),
    )
    .orderBy(desc(submissions.submittedAt))
    .limit(limit);

  return subRows.map((row) => ({
    at: row.at,
    text: `Candidate ${row.candidateName ?? 'Unknown'} has been submitted to job ${row.jobTitle ?? ''}`.trim(),
    actorName: row.actorName ?? '',
    entityType: 'submission' as const,
    entityId: row.id,
  }));
}

export type DrilldownRow = {
  id: number;
  recruiterName: string;
  candidateName: string | null;
  jobTitle: string | null;
  accountName: string | null;
  status: string | null;
  stage: string | null;
  at: string;
  entityType: string;
};

export async function buildDrilldown(
  metric: MetricKey,
  filters: AnalyticsFilters,
  limit: number,
  offset: number,
): Promise<{ rows: DrilldownRow[]; total: number }> {
  const jobIds = await resolveJobIdsForAccounts(filters.accountIds, filters.memberIds);
  if (jobIds && jobIds.length === 0) return { rows: [], total: 0 };

  if (metric === 'jobs') {
    const where = and(
      dateInRange(jobs.postedDate, filters.fromStart, filters.toExclusive),
      inUserIds(jobs.createdBy, filters.userIds),
      filters.accountIds == null
        ? undefined
        : filters.accountIds.length === 0
          ? sql`false`
          : inArray(jobs.accountId, filters.accountIds),
    );
    const total = Number(
      (await db.select({ cnt: sql<number>`count(*)` }).from(jobs).where(where))[0]?.cnt ?? 0,
    );
    const rows = await db
      .select({
        id: jobs.id,
        title: jobs.title,
        status: jobs.status,
        postedDate: jobs.postedDate,
        recruiterName: users.name,
        accountName: accounts.name,
      })
      .from(jobs)
      .leftJoin(users, eq(jobs.createdBy, users.id))
      .leftJoin(accounts, eq(jobs.accountId, accounts.id))
      .where(where)
      .orderBy(desc(jobs.postedDate))
      .limit(limit)
      .offset(offset);

    return {
      total,
      rows: rows.map((r) => ({
        id: r.id,
        recruiterName: r.recruiterName ?? '',
        candidateName: null,
        jobTitle: r.title,
        accountName: r.accountName ?? null,
        status: r.status,
        stage: null,
        at: r.postedDate,
        entityType: 'job',
      })),
    };
  }

  if (metric === 'candidates' || metric === 'poolAdded') {
    const where = and(
      dateInRange(candidates.createdAt, filters.fromStart, filters.toExclusive),
      inUserIds(candidates.createdBy, filters.userIds),
      metric === 'poolAdded' ? isNull(candidates.jobId) : undefined,
    );
    const total = Number(
      (await db.select({ cnt: sql<number>`count(*)` }).from(candidates).where(where))[0]?.cnt ?? 0,
    );
    const rows = await db
      .select({
        id: candidates.id,
        name: candidates.name,
        status: candidates.status,
        createdAt: candidates.createdAt,
        recruiterName: users.name,
        jobTitle: jobs.title,
      })
      .from(candidates)
      .leftJoin(users, eq(candidates.createdBy, users.id))
      .leftJoin(jobs, eq(candidates.jobId, jobs.id))
      .where(where)
      .orderBy(desc(candidates.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      total,
      rows: rows.map((r) => ({
        id: r.id,
        recruiterName: r.recruiterName ?? '',
        candidateName: r.name,
        jobTitle: r.jobTitle ?? null,
        accountName: null,
        status: r.status,
        stage: null,
        at: r.createdAt,
        entityType: 'candidate',
      })),
    };
  }

  if (
    metric === 'submissions' ||
    metric === 'endClientSubmissions' ||
    metric === 'confirmations'
  ) {
    const statusScope =
      metric === 'endClientSubmissions'
        ? inArray(submissions.status, [...END_CLIENT_STATUSES])
        : metric === 'confirmations'
          ? eq(submissions.status, 'client_accepted')
          : undefined;

    const where = and(
      dateInRange(submissions.submittedAt, filters.fromStart, filters.toExclusive),
      inUserIds(submissions.submittedBy, filters.userIds),
      statusScope,
      jobIds ? inArray(submissions.jobId, jobIds) : undefined,
    );

    const total = Number(
      (await db.select({ cnt: sql<number>`count(*)` }).from(submissions).where(where))[0]?.cnt ?? 0,
    );
    const rows = await db
      .select({
        id: submissions.id,
        status: submissions.status,
        submittedAt: submissions.submittedAt,
        recruiterName: users.name,
        candidateName: candidates.name,
        jobTitle: jobs.title,
        accountName: accounts.name,
      })
      .from(submissions)
      .leftJoin(users, eq(submissions.submittedBy, users.id))
      .leftJoin(candidates, eq(submissions.candidateId, candidates.id))
      .leftJoin(jobs, eq(submissions.jobId, jobs.id))
      .leftJoin(accounts, eq(jobs.accountId, accounts.id))
      .where(where)
      .orderBy(desc(submissions.submittedAt))
      .limit(limit)
      .offset(offset);

    return {
      total,
      rows: rows.map((r) => ({
        id: r.id,
        recruiterName: r.recruiterName ?? '',
        candidateName: r.candidateName,
        jobTitle: r.jobTitle,
        accountName: r.accountName,
        status: r.status,
        stage: null,
        at: r.submittedAt,
        entityType: 'submission',
      })),
    };
  }

  if (metric === 'interviews' || metric === 'poolInterviews') {
    const where = and(
      dateInRange(interviews.startTime, filters.fromStart, filters.toExclusive),
      inUserIds(interviews.createdBy, filters.userIds),
      jobIds ? inArray(interviews.jobId, jobIds) : undefined,
      metric === 'poolInterviews' ? isNull(candidates.jobId) : undefined,
    );

    const baseQuery = db
      .select({
        id: interviews.id,
        status: interviews.status,
        stage: interviews.interviewStage,
        startTime: interviews.startTime,
        recruiterName: users.name,
        candidateName: candidates.name,
        jobTitle: jobs.title,
        accountName: accounts.name,
      })
      .from(interviews)
      .leftJoin(users, eq(interviews.createdBy, users.id))
      .leftJoin(candidates, eq(interviews.candidateId, candidates.id))
      .leftJoin(jobs, eq(interviews.jobId, jobs.id))
      .leftJoin(accounts, eq(jobs.accountId, accounts.id))
      .where(where);

    const countRows = await db
      .select({ cnt: sql<number>`count(*)` })
      .from(interviews)
      .leftJoin(candidates, eq(interviews.candidateId, candidates.id))
      .where(where);

    const rows = await baseQuery.orderBy(desc(interviews.startTime)).limit(limit).offset(offset);

    return {
      total: Number(countRows[0]?.cnt ?? 0),
      rows: rows.map((r) => ({
        id: r.id,
        recruiterName: r.recruiterName ?? '',
        candidateName: r.candidateName,
        jobTitle: r.jobTitle,
        accountName: r.accountName,
        status: r.status,
        stage: r.stage,
        at: r.startTime,
        entityType: 'interview',
      })),
    };
  }

  if (metric === 'offers' || metric === 'placements' || metric === 'deferred') {
    const statusOrStage =
      metric === 'offers'
        ? eq(applications.status, 'offer')
        : metric === 'deferred'
          ? eq(applications.status, 'hold')
          : eq(jobStages.stageType, 'hired');

    if (metric === 'placements') {
      const where = and(
        statusOrStage,
        dateInRange(applications.updatedAt, filters.fromStart, filters.toExclusive),
        inUserIds(applications.createdBy, filters.userIds),
        jobIds ? inArray(applications.jobId, jobIds) : undefined,
      );
      const total = Number(
        (
          await db
            .select({ cnt: sql<number>`count(*)` })
            .from(applications)
            .innerJoin(jobStages, eq(applications.jobStageId, jobStages.id))
            .where(where)
        )[0]?.cnt ?? 0,
      );
      const rows = await db
        .select({
          id: applications.id,
          status: applications.status,
          updatedAt: applications.updatedAt,
          recruiterName: users.name,
          candidateName: candidates.name,
          jobTitle: jobs.title,
          accountName: accounts.name,
          stageType: jobStages.stageType,
        })
        .from(applications)
        .innerJoin(jobStages, eq(applications.jobStageId, jobStages.id))
        .leftJoin(users, eq(applications.createdBy, users.id))
        .leftJoin(candidates, eq(applications.candidateId, candidates.id))
        .leftJoin(jobs, eq(applications.jobId, jobs.id))
        .leftJoin(accounts, eq(jobs.accountId, accounts.id))
        .where(where)
        .orderBy(desc(applications.updatedAt))
        .limit(limit)
        .offset(offset);

      return {
        total,
        rows: rows.map((r) => ({
          id: r.id,
          recruiterName: r.recruiterName ?? '',
          candidateName: r.candidateName,
          jobTitle: r.jobTitle,
          accountName: r.accountName,
          status: r.status,
          stage: r.stageType,
          at: r.updatedAt,
          entityType: 'application',
        })),
      };
    }

    const where = and(
      statusOrStage,
      dateInRange(applications.updatedAt, filters.fromStart, filters.toExclusive),
      inUserIds(applications.createdBy, filters.userIds),
      jobIds ? inArray(applications.jobId, jobIds) : undefined,
    );
    const total = Number(
      (await db.select({ cnt: sql<number>`count(*)` }).from(applications).where(where))[0]?.cnt ?? 0,
    );
    const rows = await db
      .select({
        id: applications.id,
        status: applications.status,
        updatedAt: applications.updatedAt,
        recruiterName: users.name,
        candidateName: candidates.name,
        jobTitle: jobs.title,
        accountName: accounts.name,
      })
      .from(applications)
      .leftJoin(users, eq(applications.createdBy, users.id))
      .leftJoin(candidates, eq(applications.candidateId, candidates.id))
      .leftJoin(jobs, eq(applications.jobId, jobs.id))
      .leftJoin(accounts, eq(jobs.accountId, accounts.id))
      .where(where)
      .orderBy(desc(applications.updatedAt))
      .limit(limit)
      .offset(offset);

    return {
      total,
      rows: rows.map((r) => ({
        id: r.id,
        recruiterName: r.recruiterName ?? '',
        candidateName: r.candidateName,
        jobTitle: r.jobTitle,
        accountName: r.accountName,
        status: r.status,
        stage: null,
        at: r.updatedAt,
        entityType: 'application',
      })),
    };
  }

  if (metric === 'dropouts') {
    // Combine apps + submissions — return apps first then pad with submissions
    const appWhere = and(
      inArray(applications.status, ['no_offer', 'rejected']),
      dateInRange(applications.updatedAt, filters.fromStart, filters.toExclusive),
      inUserIds(applications.createdBy, filters.userIds),
      jobIds ? inArray(applications.jobId, jobIds) : undefined,
    );
    const subWhere = and(
      inArray(submissions.status, ['withdrawn', 'client_rejected']),
      dateInRange(submissions.submittedAt, filters.fromStart, filters.toExclusive),
      inUserIds(submissions.submittedBy, filters.userIds),
      jobIds ? inArray(submissions.jobId, jobIds) : undefined,
    );

    const appTotal = Number(
      (await db.select({ cnt: sql<number>`count(*)` }).from(applications).where(appWhere))[0]?.cnt ?? 0,
    );
    const subTotal = Number(
      (await db.select({ cnt: sql<number>`count(*)` }).from(submissions).where(subWhere))[0]?.cnt ?? 0,
    );

    const appRows = await db
      .select({
        id: applications.id,
        status: applications.status,
        updatedAt: applications.updatedAt,
        recruiterName: users.name,
        candidateName: candidates.name,
        jobTitle: jobs.title,
        accountName: accounts.name,
      })
      .from(applications)
      .leftJoin(users, eq(applications.createdBy, users.id))
      .leftJoin(candidates, eq(applications.candidateId, candidates.id))
      .leftJoin(jobs, eq(applications.jobId, jobs.id))
      .leftJoin(accounts, eq(jobs.accountId, accounts.id))
      .where(appWhere)
      .orderBy(desc(applications.updatedAt))
      .limit(limit)
      .offset(offset);

    const rows: DrilldownRow[] = appRows.map((r) => ({
      id: r.id,
      recruiterName: r.recruiterName ?? '',
      candidateName: r.candidateName,
      jobTitle: r.jobTitle,
      accountName: r.accountName,
      status: r.status,
      stage: null,
      at: r.updatedAt,
      entityType: 'application',
    }));

    if (rows.length < limit) {
      const need = limit - rows.length;
      const subOffset = Math.max(0, offset - appTotal);
      const subRows = await db
        .select({
          id: submissions.id,
          status: submissions.status,
          submittedAt: submissions.submittedAt,
          recruiterName: users.name,
          candidateName: candidates.name,
          jobTitle: jobs.title,
          accountName: accounts.name,
        })
        .from(submissions)
        .leftJoin(users, eq(submissions.submittedBy, users.id))
        .leftJoin(candidates, eq(submissions.candidateId, candidates.id))
        .leftJoin(jobs, eq(submissions.jobId, jobs.id))
        .leftJoin(accounts, eq(jobs.accountId, accounts.id))
        .where(subWhere)
        .orderBy(desc(submissions.submittedAt))
        .limit(need)
        .offset(subOffset);

      for (const r of subRows) {
        rows.push({
          id: r.id,
          recruiterName: r.recruiterName ?? '',
          candidateName: r.candidateName,
          jobTitle: r.jobTitle,
          accountName: r.accountName,
          status: r.status,
          stage: null,
          at: r.submittedAt,
          entityType: 'submission',
        });
      }
    }

    return { total: appTotal + subTotal, rows };
  }

  if (metric === 'hotlist') {
    const where = and(
      eq(campaigns.type, 'hotlist'),
      dateInRange(campaigns.createdAt, filters.fromStart, filters.toExclusive),
      inUserIds(campaigns.createdBy, filters.userIds),
    );
    const total = Number(
      (await db.select({ cnt: sql<number>`count(*)` }).from(campaigns).where(where))[0]?.cnt ?? 0,
    );
    const rows = await db
      .select({
        id: campaigns.id,
        name: campaigns.name,
        status: campaigns.status,
        createdAt: campaigns.createdAt,
        recruiterName: users.name,
      })
      .from(campaigns)
      .leftJoin(users, eq(campaigns.createdBy, users.id))
      .where(where)
      .orderBy(desc(campaigns.createdAt))
      .limit(limit)
      .offset(offset);

    return {
      total,
      rows: rows.map((r) => ({
        id: r.id,
        recruiterName: r.recruiterName ?? '',
        candidateName: null,
        jobTitle: r.name,
        accountName: null,
        status: r.status,
        stage: null,
        at: r.createdAt,
        entityType: 'campaign',
      })),
    };
  }

  // Fallback for pool split / active pool
  return buildDrilldown('candidates', filters, limit, offset);
}

export { emptyStat };
