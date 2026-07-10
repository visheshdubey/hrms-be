import { db } from '../db/index.js';
import { accounts, users } from '../db/schema.js';
import { eq, and, or, isNull, type SQL } from 'drizzle-orm';
import { isSchemaDriftError } from './schemaDrift.js';

export async function getOrgMemberIds(
  orgId: number | null,
  userId: number,
): Promise<number[]> {
  if (orgId == null) return [userId];

  const members = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.organizationId, orgId));

  return members.map((member) => member.id);
}

export async function getOrgMemberIdsFromContext(c: {
  get: (key: string) => unknown;
}): Promise<number[]> {
  const userId = c.get('userId') as number;
  const orgId = c.get('organizationId') as number | null;
  return getOrgMemberIds(orgId, userId);
}

export function isOrgMember(
  createdBy: number | null | undefined,
  memberIds: number[],
): boolean {
  if (createdBy == null) return false;
  return memberIds.includes(createdBy);
}

/** Scope rows to the user's organization, or to the user when no org is set. */
export function orgOrCreatorScope(
  orgId: number | null,
  userId: number,
  organizationIdColumn: { organizationId: any },
  createdByColumn: { createdBy: any },
): SQL {
  if (orgId != null) {
    return or(
      eq(organizationIdColumn.organizationId, orgId),
      and(isNull(organizationIdColumn.organizationId), eq(createdByColumn.createdBy, userId)),
    )!;
  }
  return eq(createdByColumn.createdBy, userId);
}

export function belongsToOrganization(
  recordOrgId: number | null | undefined,
  userOrgId: number | null,
  createdBy: number | null | undefined,
  userId: number,
): boolean {
  if (userOrgId != null) {
    if (recordOrgId != null) return recordOrgId === userOrgId;
    return createdBy === userId;
  }
  return createdBy === userId;
}

/** Whether the caller may access a record scoped by its creator (org members share access). */
export async function canAccessByCreator(
  orgId: number | null,
  userId: number,
  createdBy: number | null | undefined,
): Promise<boolean> {
  if (orgId != null) {
    const memberIds = await getOrgMemberIds(orgId, userId);
    return isOrgMember(createdBy, memberIds);
  }
  return createdBy === userId;
}

async function getAccountAccessRow(accountId: number) {
  try {
    const [account] = await db
      .select({
        organizationId: accounts.organizationId,
        createdBy: accounts.createdBy,
      })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    return account ?? null;
  } catch (error) {
    if (!isSchemaDriftError(error)) throw error;
    const [account] = await db
      .select({ createdBy: accounts.createdBy })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    if (!account) return null;
    return { organizationId: null as number | null, createdBy: account.createdBy };
  }
}

/** Whether the caller may access a job via its linked account or creator. */
export async function canAccessJob(
  job: { accountId: number | null; createdBy: number | null },
  userId: number,
  orgId: number | null,
): Promise<boolean> {
  if (job.accountId != null) {
    const account = await getAccountAccessRow(job.accountId);
    if (!account) return false;
    return belongsToOrganization(account.organizationId, orgId, account.createdBy, userId);
  }
  return canAccessByCreator(orgId, userId, job.createdBy);
}
