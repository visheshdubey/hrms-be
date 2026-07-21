import { db } from '../db/index.js';
import { accountPortalUsers, accounts, contacts, users } from '../db/schema.js';
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
 * Org portal users: only explicitly linked client accounts.
 * A unique legacy email/creator match is migrated into that explicit link once.
 */
export async function getAccessibleAccountIds(
  userId: number,
  orgId: number | null,
  role: UserRole | string | null | undefined,
): Promise<number[]> {
  if (!isOrgPortalRole(role)) {
    return getAccountIdsInOrg(orgId, userId);
  }

  const membershipRows = await db
    .select({ id: accounts.id })
    .from(accountPortalUsers)
    .innerJoin(accounts, eq(accountPortalUsers.accountId, accounts.id))
    .where(
      orgId == null
        ? eq(accountPortalUsers.userId, userId)
        : and(eq(accountPortalUsers.userId, userId), eq(accounts.organizationId, orgId)),
    );
  if (membershipRows.length > 0) {
    return membershipRows.map((row) => row.id);
  }

  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  const email = user?.email?.trim().toLowerCase() ?? '';
  const legacyIds = new Set<number>();

  if (email) {
    const contactRows = await db
      .select({ accountId: contacts.accountId })
      .from(contacts)
      .innerJoin(accounts, eq(contacts.accountId, accounts.id))
      .where(
        orgId == null
          ? sql`lower(trim(${contacts.email})) = ${email}`
          : and(
              sql`lower(trim(${contacts.email})) = ${email}`,
              eq(accounts.organizationId, orgId),
            ),
      );

    for (const row of contactRows) {
      if (row.accountId != null) legacyIds.add(row.accountId);
    }

    const accountEmailWhere =
      orgId != null
        ? and(
            sql`lower(trim(${accounts.email})) = ${email}`,
            eq(accounts.organizationId, orgId),
          )
        : sql`lower(trim(${accounts.email})) = ${email}`;

    const byAccountEmail = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(accountEmailWhere!);
    for (const row of byAccountEmail) legacyIds.add(row.id);
  }

  const createdWhere =
    orgId != null
      ? and(
          eq(accounts.createdBy, userId),
          eq(accounts.organizationId, orgId),
        )
      : eq(accounts.createdBy, userId);

  const createdRows = await db.select({ id: accounts.id }).from(accounts).where(createdWhere!);
  for (const row of createdRows) legacyIds.add(row.id);

  // Never guess when an email maps to multiple client companies.
  if (legacyIds.size !== 1) {
    return [];
  }

  const [accountId] = [...legacyIds];
  await db
    .insert(accountPortalUsers)
    .values({ accountId, userId })
    .onConflictDoNothing();
  return [accountId];
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
