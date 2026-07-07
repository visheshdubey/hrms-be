import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  accounts,
  accountStageTemplates,
  applications,
  applicationStageHistory,
  calendarEvents,
  contacts,
  interviews,
  jobShortlists,
  jobs,
  jobStages,
  submissions,
} from '../db/schema.js';

export type AccountDeletePreview = {
  accountId: number;
  contacts: number;
  jobs: number;
  applications: number;
  stageTemplates: number;
};

export async function getAccountDeletePreview(accountId: number): Promise<AccountDeletePreview> {
  const accountJobs = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.accountId, accountId));

  const jobIds = accountJobs.map((job) => job.id);

  let applicationCount = 0;
  if (jobIds.length > 0) {
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(applications)
      .where(inArray(applications.jobId, jobIds));
    applicationCount = Number(row?.count ?? 0);
  }

  const [contactRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(contacts)
    .where(eq(contacts.accountId, accountId));

  const [templateRow] = await db
    .select({ count: sql<number>`count(*)` })
    .from(accountStageTemplates)
    .where(eq(accountStageTemplates.accountId, accountId));

  return {
    accountId,
    contacts: Number(contactRow?.count ?? 0),
    jobs: jobIds.length,
    applications: applicationCount,
    stageTemplates: Number(templateRow?.count ?? 0),
  };
}

/** Delete account and all CRM data owned by it (contacts, jobs, applications, templates). */
export async function cascadeDeleteAccount(accountId: number): Promise<void> {
  const accountJobs = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.accountId, accountId));

  const jobIds = accountJobs.map((job) => job.id);

  if (jobIds.length > 0) {
    const appRows = await db
      .select({ id: applications.id })
      .from(applications)
      .where(inArray(applications.jobId, jobIds));
    const applicationIds = appRows.map((row) => row.id);

    if (applicationIds.length > 0) {
      await db
        .delete(applicationStageHistory)
        .where(inArray(applicationStageHistory.applicationId, applicationIds));
    }

    await db.delete(applications).where(inArray(applications.jobId, jobIds));
    await db.delete(submissions).where(inArray(submissions.jobId, jobIds));
    await db.delete(interviews).where(inArray(interviews.jobId, jobIds));
    await db.delete(calendarEvents).where(inArray(calendarEvents.jobId, jobIds));
    await db.delete(jobShortlists).where(inArray(jobShortlists.jobId, jobIds));
    await db.delete(jobStages).where(inArray(jobStages.jobId, jobIds));
    await db.delete(jobs).where(inArray(jobs.id, jobIds));
  }

  await db.delete(contacts).where(eq(contacts.accountId, accountId));
  await db.delete(accountStageTemplates).where(eq(accountStageTemplates.accountId, accountId));
  await db.delete(accounts).where(eq(accounts.id, accountId));
}
