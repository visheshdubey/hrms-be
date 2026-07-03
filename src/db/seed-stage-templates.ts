/**
 * Backfill client stage templates for existing demo DBs (safe to re-run).
 * Usage: npm run db:seed:stages
 */
import { eq } from 'drizzle-orm';
import { db } from './index.js';
import { accounts, accountStageTemplates } from './schema.js';
import { applyTemplatesToAccountJobsWithoutStages } from '../lib/stages.js';

const DEFAULT_CLIENT_STAGES = [
  { name: 'Candidate applies', orderIndex: 0, stageType: 'application' as const },
  { name: 'Email notification', orderIndex: 1, stageType: 'application' as const },
  { name: 'Technical round', orderIndex: 2, stageType: 'interview' as const },
  { name: 'Management round', orderIndex: 3, stageType: 'interview' as const },
  { name: 'Offer letter', orderIndex: 4, stageType: 'application' as const },
  { name: 'Job closed', orderIndex: 5, stageType: 'application' as const },
];

async function seedStageTemplates() {
  try {
    console.log('🌱 Backfilling client stage templates…');

    const allAccounts = await db.select({ id: accounts.id, name: accounts.name }).from(accounts);
    if (allAccounts.length === 0) {
      console.log('⚠️  No accounts found. Run npm run db:seed first.');
      return;
    }

    let templatesCreated = 0;
    let jobsUpdated = 0;

    for (const account of allAccounts) {
      const existing = await db
        .select({ id: accountStageTemplates.id })
        .from(accountStageTemplates)
        .where(eq(accountStageTemplates.accountId, account.id))
        .limit(1);

      if (existing.length === 0) {
        for (const stage of DEFAULT_CLIENT_STAGES) {
          await db.insert(accountStageTemplates).values({
            accountId: account.id,
            name: stage.name,
            orderIndex: stage.orderIndex,
            stageType: stage.stageType,
          });
        }
        templatesCreated += 1;
        console.log(`   ✓ Templates created for ${account.name}`);
      }

      const applied = await applyTemplatesToAccountJobsWithoutStages(account.id);
      jobsUpdated += applied.jobsUpdated;
    }

    console.log('✅ Stage template backfill complete');
    console.log(`   Accounts seeded: ${templatesCreated}`);
    console.log(`   Jobs updated:    ${jobsUpdated}`);
  } catch (err) {
    console.error('❌ Stage template seed failed:', err);
    process.exit(1);
  }
}

seedStageTemplates();
