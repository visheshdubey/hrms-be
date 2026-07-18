import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { contacts, users } from '../db/schema.js';
import { JWT_SECRET } from '../config.js';
import { queueInviteEmail } from '../queue/email-service.js';
import { sendInviteEmail } from '../utils/email.js';

export type PortalInviteResult =
  | { invited: true; emailSent: boolean; userId: number; email: string }
  | { invited: false; reason: string; email?: string };

async function dispatchInviteEmail(
  email: string,
  inviterName: string,
  verifyToken: string,
): Promise<boolean> {
  try {
    const result = await queueInviteEmail(email, inviterName, verifyToken);
    return result.queued || result.inline === true;
  } catch (error) {
    console.error('[client-portal-invite] queue failed, inline fallback:', error);
    return sendInviteEmail(email, inviterName, verifyToken);
  }
}

/**
 * Create an Org portal login for a CRM client account (same recruiter workspace)
 * and email a set-password / accept-invite link.
 */
export async function inviteClientPortalUser(input: {
  email: string;
  companyName: string;
  accountId: number;
  organizationId: number | null;
  invitedByUserId: number;
  inviterName: string;
  contactPhone?: string;
}): Promise<PortalInviteResult> {
  const email = input.email.trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return { invited: false, reason: 'Valid email is required to invite the client portal user' };
  }

  if (input.organizationId == null) {
    return { invited: false, reason: 'Recruiter workspace (organization) is missing' };
  }

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing.length > 0) {
    return {
      invited: false,
      reason: 'A user with this email already exists. They can sign in if already invited.',
      email,
    };
  }

  const displayName = input.companyName.trim() || email.split('@')[0] || 'Client Admin';

  const [createdUser] = await db
    .insert(users)
    .values({
      name: displayName,
      email,
      password: null,
      isVerified: 0,
      role: 'org_admin',
      portalType: 'org',
      organizationId: input.organizationId,
    })
    .returning({ id: users.id, email: users.email });

  const now = new Date().toISOString();
  try {
    await db.insert(contacts).values({
      accountId: input.accountId,
      firstName: displayName.split(/\s+/)[0] || 'Client',
      lastName: displayName.split(/\s+/).slice(1).join(' ') || 'Admin',
      email,
      phone: input.contactPhone ?? '',
      jobTitle: 'Primary contact',
      department: 'HR',
      status: 'active',
      organizationId: input.organizationId,
      createdBy: input.invitedByUserId,
      updatedAt: now,
    });
  } catch (error) {
    console.error('[client-portal-invite] contact create failed (non-fatal):', error);
  }

  const verifyToken = jwt.sign({ email: createdUser.email, type: 'verify' }, JWT_SECRET, {
    expiresIn: '7d',
  });
  const emailSent = await dispatchInviteEmail(email, input.inviterName, verifyToken);

  return {
    invited: true,
    emailSent,
    userId: createdUser.id,
    email: createdUser.email,
  };
}

/** Unused import guard — bcrypt kept available if we later seed temp passwords. */
void bcrypt;
