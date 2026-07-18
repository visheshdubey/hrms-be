import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, contacts, organizations, users } from '../db/schema.js';
import { getAccessibleAccountIds } from './orgScope.js';

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
 * Ensure this Org portal user has at least one linked CRM account (their company only).
 * Does NOT return another client's account in a shared agency workspace.
 */
export async function ensureOrgUserLinkedAccount(input: {
  organizationId: number;
  userId: number;
  role: string | null;
  accountName?: string;
}): Promise<{ id: number; name: string }> {
  const linked = await getAccessibleAccountIds(input.userId, input.organizationId, input.role);
  if (linked.length > 0) {
    const [row] = await db
      .select({ id: accounts.id, name: accounts.name })
      .from(accounts)
      .where(eq(accounts.id, linked[0]))
      .limit(1);
    if (row) return row;
  }

  const [user] = await db
    .select({ email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);

  let name = input.accountName?.trim() || user?.name?.trim() || '';
  if (!name) {
    const [org] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .limit(1);
    name = org?.name?.trim() || 'My Company';
  }

  const created = await createNamedClientAccount({
    organizationId: input.organizationId,
    createdBy: input.userId,
    accountName: name,
    email: user?.email ?? '',
  });

  const email = user?.email?.trim().toLowerCase() ?? '';
  if (email) {
    const now = new Date().toISOString();
    const display = user?.name?.trim() || email.split('@')[0] || 'Client';
    try {
      await db.insert(contacts).values({
        accountId: created.id,
        firstName: display.split(/\s+/)[0] || 'Client',
        lastName: display.split(/\s+/).slice(1).join(' ') || 'Admin',
        email,
        phone: '',
        jobTitle: 'Primary contact',
        department: 'HR',
        status: 'active',
        organizationId: input.organizationId,
        createdBy: input.userId,
        updatedAt: now,
      });
    } catch {
      // non-fatal — account alone is enough for Post Job
    }
  }

  return created;
}

/**
 * Ensure at least one CRM account exists for a workspace (empty-DB / single-tenant fallback).
 * Prefer ensureOrgUserLinkedAccount for multi-client agency org users.
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
