import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, organizations } from '../db/schema.js';

/**
 * Org portal posts jobs against CRM "client" accounts.
 * New org registrations used to create zero accounts → empty Post Job dropdown.
 * Ensure at least one account exists for the organization (named after the org).
 */
export async function ensureOrgDefaultAccount(input: {
  organizationId: number;
  createdBy: number;
  accountName?: string;
}): Promise<{ id: number; name: string }> {
  const existing = await db
    .select({ id: accounts.id, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.organizationId, input.organizationId))
    .limit(1);

  if (existing[0]) {
    return existing[0];
  }

  let name = input.accountName?.trim() || '';
  if (!name) {
    const [org] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .limit(1);
    name = org?.name?.trim() || 'My Company';
  }

  const now = new Date().toISOString();
  const [created] = await db
    .insert(accounts)
    .values({
      name,
      status: 'active',
      type: 'client',
      organizationId: input.organizationId,
      createdBy: input.createdBy,
      updatedAt: now,
    })
    .returning({ id: accounts.id, name: accounts.name });

  return created;
}
