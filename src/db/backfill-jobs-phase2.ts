import { asc, eq } from 'drizzle-orm';
import { db } from './index.js';
import {
  applications,
  accountStageTemplates,
  jobStages,
  jobs,
  users,
} from './schema.js';
import { getFirstJobStageId } from '../lib/applicationDefaults.js';
import { defaultStageColor } from '../lib/stageColors.js';

async function backfillJobsPhase2() {
  console.log('🔧 Backfilling Jobs Phase 2 fields…');

  const templates = await db.select().from(accountStageTemplates);
  for (const template of templates) {
    if (!template.color || template.color === '#6366f1') {
      await db
        .update(accountStageTemplates)
        .set({ color: defaultStageColor(template.orderIndex) })
        .where(eq(accountStageTemplates.id, template.id));
    }
  }

  const stages = await db.select().from(jobStages);
  for (const stage of stages) {
    if (!stage.color) {
      await db
        .update(jobStages)
        .set({ color: defaultStageColor(stage.orderIndex) })
        .where(eq(jobStages.id, stage.id));
    }
  }

  const staffUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, 'staff@demo.com'))
    .limit(1);
  const defaultStaffId = staffUsers[0]?.id ?? null;

  const allJobs = await db.select().from(jobs);
  for (const job of allJobs) {
    if (job.assignedTo == null && defaultStaffId != null) {
      await db.update(jobs).set({ assignedTo: defaultStaffId }).where(eq(jobs.id, job.id));
    }
  }

  const allApps = await db.select().from(applications);
  let appsUpdated = 0;

  for (const app of allApps) {
    const patch: { jobStageId?: number | null; assignedTo?: number | null } = {};

    if (app.jobStageId == null) {
      patch.jobStageId = await getFirstJobStageId(app.jobId);
    }

    if (app.assignedTo == null) {
      const [job] = await db.select().from(jobs).where(eq(jobs.id, app.jobId)).limit(1);
      if (job?.assignedTo != null) {
        patch.assignedTo = job.assignedTo;
      }
    }

    if (Object.keys(patch).length > 0) {
      await db.update(applications).set(patch).where(eq(applications.id, app.id));
      appsUpdated += 1;
    }
  }

  const jobsMissingStages = await db
    .select({ id: jobs.id })
    .from(jobs)
  ;

  let jobsWithStages = 0;
  for (const job of jobsMissingStages) {
    const [existing] = await db
      .select({ id: jobStages.id })
      .from(jobStages)
      .where(eq(jobStages.jobId, job.id))
      .limit(1);
    if (!existing) continue;
    jobsWithStages += 1;
  }

  console.log(`✅ Templates/stages colored, jobs assigned, ${appsUpdated} applications updated.`);
  console.log(`   Jobs with pipeline stages: ${jobsWithStages}`);
}

backfillJobsPhase2()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Backfill failed:', error);
    process.exit(1);
  });
