import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, organizations } from '../db/schema.js';

/**
 * Create a CRM client account in a workspace (always inserts a new named company).
 * Used when an Org portal user joins the agency via public signup.
 */
export async function createNamedClientAccount(input: {
  organizationId: number;
  createdBy: number;
  accountName: string;
  email?: string;
  phone?: string;
}): Promise<{ id: number; name: string }> {
  const name = input.accountName.trim() || 'Client company';
  const now = new Date().toISOString();
  const [created] = await db
    .insert(accounts)
    .values({
      name,
      status: 'active',
      type: 'client',
      email: input.email ?? '',
      phone: input.phone ?? '',
      organizationId: input.organizationId,
      createdBy: input.createdBy,
      updatedAt: now,
    })
    .returning({ id: accounts.id, name: accounts.name });

  return created;
}

/**
 * Ensure at least one CRM account exists for a workspace (Post Job empty-state fix).
 * If any account already exists, returns the first — does not create duplicates.
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

  return createNamedClientAccount({
    organizationId: input.organizationId,
    createdBy: input.createdBy,
    accountName: name,
  });
}
