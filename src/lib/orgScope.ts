import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq, and, or, isNull, type SQL } from 'drizzle-orm';

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
