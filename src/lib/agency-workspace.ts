import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { organizations, users } from '../db/schema.js';

/**
 * Shared agency workspace for dual portals (Recruiter + Org/Client).
 * Org signup joins this org so the company appears under Recruiter → Clients.
 *
 * Override with env AGENCY_ORGANIZATION_ID when multiple agencies exist.
 */
export async function resolveAgencyOrganizationId(): Promise<number | null> {
  const raw = process.env.AGENCY_ORGANIZATION_ID?.trim();
  if (raw) {
    const id = Number.parseInt(raw, 10);
    if (Number.isFinite(id) && id > 0) return id;
  }

  const [recruiterOrg] = await db
    .select({ organizationId: users.organizationId })
    .from(users)
    .where(
      and(
        eq(users.portalType, 'recruiter'),
        eq(users.role, 'recruiter_admin'),
        isNotNull(users.organizationId),
      ),
    )
    .limit(1);

  if (recruiterOrg?.organizationId) {
    return recruiterOrg.organizationId;
  }

  const [anyRecruiter] = await db
    .select({ organizationId: users.organizationId })
    .from(users)
    .where(and(eq(users.portalType, 'recruiter'), isNotNull(users.organizationId)))
    .limit(1);

  return anyRecruiter?.organizationId ?? null;
}

export async function getOrganizationName(organizationId: number): Promise<string> {
  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return org?.name?.trim() || 'Agency';
}
