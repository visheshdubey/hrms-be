import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { eq, inArray } from 'drizzle-orm';

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
