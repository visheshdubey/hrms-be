import { db } from '../db/index.js';
import { accounts, contacts, users } from '../db/schema.js';
import { eq, and, or, isNull, sql, inArray, type SQL } from 'drizzle-orm';
import { isSchemaDriftError } from './schemaDrift.js';
import type { UserRole } from '../middleware.js';

export function isOrgPortalRole(role: UserRole | string | null | undefined): boolean {
  return role === 'org_admin' || role === 'org_staff';
}

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

async function getAccountIdsInOrg(orgId: number | null, userId: number): Promise<number[]> {
  try {
    const orgAccounts = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(orgOrCreatorScope(orgId, userId, accounts, accounts));
    return orgAccounts.map((account) => account.id);
  } catch (error) {
    if (!isSchemaDriftError(error)) throw error;
    const memberIds = await getOrgMemberIds(orgId, userId);
    const orgAccounts = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(inArray(accounts.createdBy, memberIds));
    return orgAccounts.map((account) => account.id);
  }
}

/**
 * Account IDs the caller may use.
 * Recruiters: all accounts in the agency workspace.
 * Org portal users: only their client company, linked by:
 *   1) contacts.email match
 *   2) accounts.email match (Add client email)
 *   3) accounts.created_by = this user (org self-signup company)
 */
export async function getAccessibleAccountIds(
  userId: number,
  orgId: number | null,
  role: UserRole | string | null | undefined,
): Promise<number[]> {
  if (!isOrgPortalRole(role)) {
    return getAccountIdsInOrg(orgId, userId);
  }

  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const email = user?.email?.trim().toLowerCase() ?? '';
  const ids = new Set<number>();

  if (email) {
    const contactRows = await db
      .select({ accountId: contacts.accountId })
      .from(contacts)
      .where(sql`lower(trim(${contacts.email})) = ${email}`);

    for (const row of contactRows) {
      if (row.accountId != null) ids.add(row.accountId);
    }

    const accountEmailWhere =
      orgId != null
        ? and(
            sql`lower(trim(${accounts.email})) = ${email}`,
            or(eq(accounts.organizationId, orgId), isNull(accounts.organizationId)),
          )
        : sql`lower(trim(${accounts.email})) = ${email}`;

    const byAccountEmail = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(accountEmailWhere!);
    for (const row of byAccountEmail) ids.add(row.id);
  }

  const createdWhere =
    orgId != null
      ? and(
          eq(accounts.createdBy, userId),
          or(eq(accounts.organizationId, orgId), isNull(accounts.organizationId)),
        )
      : eq(accounts.createdBy, userId);

  const createdRows = await db.select({ id: accounts.id }).from(accounts).where(createdWhere!);
  for (const row of createdRows) ids.add(row.id);

  // Drop accounts outside this agency when org is set.
  if (orgId != null && ids.size > 0) {
    const scoped = await db
      .select({ id: accounts.id, organizationId: accounts.organizationId })
      .from(accounts)
      .where(inArray(accounts.id, [...ids]));
    return scoped
      .filter(
        (row) =>
          row.organizationId === orgId ||
          row.organizationId == null,
      )
      .map((row) => row.id);
  }

  return [...ids];
}

export async function canAccessAccountId(
  accountId: number,
  userId: number,
  orgId: number | null,
  role: UserRole | string | null | undefined,
): Promise<boolean> {
  const accessible = await getAccessibleAccountIds(userId, orgId, role);
  return accessible.includes(accountId);
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
  role?: UserRole | string | null,
): Promise<boolean> {
  if (isOrgPortalRole(role)) {
    if (job.accountId != null) {
      return canAccessAccountId(job.accountId, userId, orgId, role);
    }
    // Orphan jobs (no account): only the creator in the org portal.
    return job.createdBy === userId;
  }

  if (job.accountId != null) {
    const account = await getAccountAccessRow(job.accountId);
    if (!account) return false;
    return belongsToOrganization(account.organizationId, orgId, account.createdBy, userId);
  }
  return canAccessByCreator(orgId, userId, job.createdBy);
}
