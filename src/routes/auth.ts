import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import { accountPortalUsers, organizations, users } from '../db/schema.js';
import { and, eq, inArray } from 'drizzle-orm';
import { sendInviteEmail, sendPasswordResetEmail, sendPasswordOtpEmail } from '../utils/email.js';
import {
  queueInviteEmail,
  queuePasswordOtpEmail,
  queuePasswordResetEmail,
} from '../queue/email-service.js';
import { JWT_SECRET } from '../config.js';
import { getAccessibleAccountIds } from '../lib/orgScope.js';

async function canManageTeamUser(
  me: typeof users.$inferSelect,
  target: typeof users.$inferSelect,
): Promise<boolean> {
  if (me.organizationId !== target.organizationId) return false;
  if ((me.portalType ?? 'recruiter') === 'recruiter') {
    return (target.portalType ?? 'recruiter') === 'recruiter';
  }
  const accountIds = await getAccessibleAccountIds(
    me.id,
    me.organizationId,
    me.role,
  );
  if (accountIds.length === 0) return false;
  const [membership] = await db
    .select({ userId: accountPortalUsers.userId })
    .from(accountPortalUsers)
    .where(and(
      eq(accountPortalUsers.userId, target.id),
      inArray(accountPortalUsers.accountId, accountIds),
    ))
    .limit(1);
  return Boolean(membership);
}

async function dispatchEmail(
  queueFn: () => Promise<{ queued: boolean; inline?: boolean }>,
  fallbackFn: () => Promise<boolean>,
): Promise<boolean> {
  try {
    const result = await queueFn();
    return result.queued || result.inline === true;
  } catch (error) {
    console.error('[auth/email] queue failed, using inline fallback:', error);
    return fallbackFn();
  }
}

const auth = new Hono({ strict: false });

type UserRole = 'recruiter_admin' | 'recruited_staff' | 'org_admin' | 'org_staff';
type PortalType = 'org' | 'recruiter';

const userProfileFields = {
  id: users.id,
  name: users.name,
  email: users.email,
  role: users.role,
  portalType: users.portalType,
  organizationId: users.organizationId,
  avatar: users.avatar,
  country: users.country,
  timezone: users.timezone,
  bio: users.bio,
  isActive: users.isActive,
};

function normalizeInviteRole(role: string | undefined, portal: PortalType): UserRole {
  const normalized = (role ?? '').toLowerCase().replace(/\s+/g, '_');

  // Explicit org / recruiter API roles (recruiter admin may invite client portal users)
  if (normalized === 'org_admin') return 'org_admin';
  if (normalized === 'org_staff') return 'org_staff';
  if (normalized === 'recruiter_admin' || normalized === 'admin') {
    return portal === 'org' ? 'org_admin' : 'recruiter_admin';
  }
  if (normalized === 'recruited_staff' || normalized === 'staff') {
    return portal === 'org' ? 'org_staff' : 'recruited_staff';
  }

  if (portal === 'org') {
    return 'org_staff';
  }
  return 'recruited_staff';
}

function portalForRole(role: UserRole, inviterPortal: PortalType): PortalType {
  if (role === 'org_admin' || role === 'org_staff') return 'org';
  if (role === 'recruiter_admin' || role === 'recruited_staff') return 'recruiter';
  return inviterPortal;
}

const RECRUITER_ROLES: UserRole[] = ['recruiter_admin', 'recruited_staff'];
const ORG_ROLES: UserRole[] = ['org_admin', 'org_staff'];

function assertCanInvite(
  inviterPortal: PortalType,
  inviterRole: UserRole,
  targetRole: UserRole,
): string | null {
  if (inviterPortal === 'org') {
    if (!ORG_ROLES.includes(targetRole)) {
      return 'Org admins can only invite Org Admin or Org Staff roles.';
    }
    return null;
  }

  // Recruiter admin may invite both recruiter team and client (org) portal users.
  if (inviterRole === 'recruiter_admin') {
    return null;
  }

  if (!RECRUITER_ROLES.includes(targetRole)) {
    return 'Recruiter staff can only invite Recruiter Admin or Recruiter Staff roles.';
  }
  return null;
}

const inviteSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email address"),
  role: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

const verifySchema = z.object({
  token: z.string(),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

const forgotPasswordSchema = z.object({
  email: z.string().email("Invalid email address"),
});

const resetPasswordSchema = z.object({
  token: z.string(),
  password: z.string().min(6, "Password must be at least 6 characters"),
  confirmPassword: z.string().min(6, "Password must be at least 6 characters"),
});

const orgUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  logo: z.string().optional(),
  defaults: z.record(z.string(), z.unknown()).optional(),
});

// FORGOT PASSWORD — send reset email
auth.post('/forgot-password', zValidator('json', forgotPasswordSchema), async (c) => {
  try {
    const { email } = c.req.valid('json');
    const user = await db.select().from(users).where(eq(users.email, email)).limit(1);

    if (user.length > 0 && user[0].isVerified === 1 && user[0].password) {
      const resetToken = jwt.sign({ email, type: 'reset' }, JWT_SECRET, { expiresIn: '1h' });
      await dispatchEmail(
        () => queuePasswordResetEmail(email, resetToken),
        () => sendPasswordResetEmail(email, resetToken),
      ).catch((err) => {
        console.error('[forgot-password] email delivery failed (non-fatal):', err);
      });
    }

    // Always return success to avoid email enumeration
    return c.json({ message: 'If an account exists with that email, a reset link has been sent.' }, 200);
  } catch (err) {
    console.error('[forgot-password] error:', err);
    // Still return 200 — never leak whether the account exists
    return c.json({ message: 'If an account exists with that email, a reset link has been sent.' }, 200);
  }
});

// RESET PASSWORD — token from email link
auth.post('/reset-password', zValidator('json', resetPasswordSchema), async (c) => {
  try {
    const { token, password, confirmPassword } = c.req.valid('json');

    if (password !== confirmPassword) {
      return c.json({ error: 'Passwords do not match' }, 400);
    }

    const decoded = jwt.verify(token, JWT_SECRET) as { email: string; type: string };
    if (decoded.type !== 'reset') {
      return c.json({ error: 'Invalid token type' }, 400);
    }

    const user = await db.select().from(users).where(eq(users.email, decoded.email)).limit(1);
    if (user.length === 0) {
      return c.json({ error: 'User not found' }, 404);
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await db.update(users).set({ password: hashedPassword, isVerified: 1 })
      .where(eq(users.email, decoded.email));

    return c.json({ message: 'Password reset successfully. You can now sign in.' }, 200);
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
});

// GET /auth/organization — org profile for settings page
auth.get('/organization', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number };

    const user = await db.select().from(users).where(eq(users.id, decoded.id)).limit(1);
    if (!user.length || !user[0].organizationId) {
      return c.json({ error: 'Organization not found' }, 404);
    }

    const org = await db.select().from(organizations)
      .where(eq(organizations.id, user[0].organizationId)).limit(1);

    if (!org.length) return c.json({ error: 'Organization not found' }, 404);

    let defaults: Record<string, unknown> = {};
    try { defaults = JSON.parse(org[0].defaults || '{}'); } catch { /* ignore */ }

    return c.json({
      id: org[0].id,
      name: org[0].name,
      logo: org[0].logo ?? '',
      defaults,
    });
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
});

// PUT /auth/organization — update org settings (admin only)
auth.put('/organization', zValidator('json', orgUpdateSchema), async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);

  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number };

    const user = await db.select().from(users).where(eq(users.id, decoded.id)).limit(1);
    if (!user.length) return c.json({ error: 'User not found' }, 404);

    const role = user[0].role;
    if (role !== 'recruiter_admin') {
      return c.json({ error: 'Forbidden: recruiter admin access required' }, 403);
    }
    if (!user[0].organizationId) return c.json({ error: 'Organization not found' }, 404);

    const body = c.req.valid('json');
    const patch: Record<string, unknown> = {};
    if (body.name != null) patch.name = body.name;
    if (body.logo != null) patch.logo = body.logo;
    if (body.defaults != null) {
      // Merge so partial workspace saves (e.g. logos only) do not wipe other defaults.
      let existingDefaults: Record<string, unknown> = {};
      const [currentOrg] = await db
        .select({ defaults: organizations.defaults })
        .from(organizations)
        .where(eq(organizations.id, user[0].organizationId))
        .limit(1);
      try {
        existingDefaults = JSON.parse(currentOrg?.defaults || '{}');
      } catch {
        /* ignore */
      }
      const merged: Record<string, unknown> = { ...existingDefaults };
      for (const [key, value] of Object.entries(body.defaults)) {
        if (value === undefined) continue;
        merged[key] = value;
      }
      patch.defaults = JSON.stringify(merged);
    }

    const [updated] = await db.update(organizations).set(patch as any)
      .where(eq(organizations.id, user[0].organizationId)).returning();

    let defaults: Record<string, unknown> = {};
    try { defaults = JSON.parse(updated.defaults || '{}'); } catch { /* ignore */ }

    return c.json({
      id: updated.id,
      name: updated.name,
      logo: updated.logo ?? '',
      defaults,
      message: 'Organization updated',
    });
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
});

// Public self-registration disabled — closed / invite-only platform.
auth.post('/register', async (c) => {
  return c.json(
    {
      error:
        'Public registration is disabled. Ask your recruiter or admin for an invitation.',
    },
    403,
  );
});

// INVITE TEAM MEMBER (Protected)
auth.post('/invite', zValidator('json', inviteSchema), async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const { name, email, role: inviteRole } = c.req.valid('json');
    const tokenStr = authHeader.split(' ')[1];
    const decoded = jwt.verify(tokenStr, JWT_SECRET) as { id: number; email: string };

    const existingUser = await db.select().from(users).where(eq(users.email, email));
    if (existingUser.length > 0) {
      return c.json({ error: 'User already exists' }, 400);
    }

    const inviter = await db.select().from(users).where(eq(users.id, decoded.id)).limit(1);
    if (inviter.length === 0) {
      return c.json({ error: 'Inviter not found' }, 404);
    }

    const inviterUser = inviter[0];
    const inviterPortal = (inviterUser.portalType ?? 'recruiter') as PortalType;
    const inviterRole = (inviterUser.role ?? 'recruited_staff') as UserRole;
    const resolvedRole = normalizeInviteRole(inviteRole, inviterPortal);
    const inviteError = assertCanInvite(inviterPortal, inviterRole, resolvedRole);
    if (inviteError) {
      return c.json({ error: inviteError }, 403);
    }
    const portal = portalForRole(resolvedRole, inviterPortal);

    const newUser = await db.insert(users).values({
      name,
      email,
      password: null,
      isVerified: 0,
      role: resolvedRole,
      portalType: portal,
      organizationId: inviterUser.organizationId,
    }).returning(userProfileFields);

    if (inviterPortal === 'org') {
      const accountIds = await getAccessibleAccountIds(
        inviterUser.id,
        inviterUser.organizationId,
        inviterUser.role,
      );
      if (accountIds.length !== 1) {
        await db.delete(users).where(eq(users.id, newUser[0].id));
        return c.json({ error: 'Could not resolve the client account for this invitation' }, 400);
      }
      await db.insert(accountPortalUsers).values({
        accountId: accountIds[0],
        userId: newUser[0].id,
      });
    }

    const verifyToken = jwt.sign({ email: newUser[0].email, type: 'verify' }, JWT_SECRET, { expiresIn: '1d' });
    const emailSent = await dispatchEmail(
      () => queueInviteEmail(email, inviterUser.name, verifyToken),
      () => sendInviteEmail(email, inviterUser.name, verifyToken),
    );

    return c.json({
      message: 'Invitation sent successfully. They will receive an email shortly.',
      user: newUser[0],
      emailSent,
    }, 201);
  } catch (error) {
    return c.json({ error: 'Internal Server Error' }, 500);
  }
});

// VERIFY AND SET PASSWORD
auth.post('/verify-link', zValidator('json', verifySchema), async (c) => {
  try {
    const { token, password } = c.req.valid('json');

    const decoded = jwt.verify(token, JWT_SECRET) as { email: string; type: string };
    if (decoded.type !== 'verify') {
      return c.json({ error: 'Invalid token type' }, 400);
    }

    const user = await db.select().from(users).where(eq(users.email, decoded.email));
    if (user.length === 0) {
      return c.json({ error: 'User not found' }, 404);
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const updatedUser = await db.update(users).set({
      password: hashedPassword,
      isVerified: 1,
    }).where(eq(users.email, decoded.email))
      .returning(userProfileFields);

    const loginToken = jwt.sign({ id: updatedUser[0].id, email: updatedUser[0].email }, JWT_SECRET, { expiresIn: '1d' });

    return c.json({ message: 'Password set successfully', token: loginToken, user: updatedUser[0] }, 200);
  } catch (error) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
});

// LOGIN
auth.post('/login', zValidator('json', loginSchema), async (c) => {
  try {
    const { email, password } = c.req.valid('json');

    const user = await db.select().from(users).where(eq(users.email, email));
    if (user.length === 0) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    if (user[0].isVerified === 0 || !user[0].password) {
      return c.json({ error: 'Please verify your email to set a password before logging in' }, 403);
    }

    const validPassword = await bcrypt.compare(password, user[0].password);
    if (!validPassword) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    const token = jwt.sign({ id: user[0].id, email: user[0].email }, JWT_SECRET, { expiresIn: '1d' });

    return c.json({
      user: {
        id: user[0].id,
        name: user[0].name,
        email: user[0].email,
        role: user[0].role,
        portalType: user[0].portalType,
        organizationId: user[0].organizationId,
        avatar: user[0].avatar ?? null,
        country: user[0].country ?? null,
        timezone: user[0].timezone ?? null,
        bio: user[0].bio ?? null,
        isActive: user[0].isActive,
      },
      token,
    }, 200);
  } catch (error) {
    console.error('[POST /login] Error:', error);
    const message =
      error instanceof Error && /connect|ECONNREFUSED|timeout/i.test(error.message)
        ? 'Database unavailable. Start Postgres: cd hrms-be && npm run db:up && npm run db:seed:users'
        : 'Internal Server Error';
    return c.json({ error: message }, 500);
  }
});

// PROTECTED ROUTE (Get my profile)
auth.get('/me', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number; email: string };
    const user = await db.select(userProfileFields).from(users).where(eq(users.id, decoded.id));

    if (user.length === 0) return c.json({ error: 'User not found' }, 404);

    return c.json({ user: user[0] }, 200);
  } catch (error) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
});

const updateSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  email: z.string().email("Invalid email").optional(),
  avatarUrl: z.string().optional(),
  role: z.string().optional(),
  country: z.string().optional(),
  timezone: z.string().optional(),
  bio: z.string().optional(),
  currentPassword: z.string().optional(),
  newPassword: z.string().min(6, "Password must be at least 6 characters").optional(),
});

// PROTECTED ROUTE (Update my profile)
auth.put('/me', zValidator('json', updateSchema), async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number; email: string };
    const { firstName, lastName, email, avatarUrl, role, country, timezone, bio, currentPassword, newPassword } = c.req.valid('json');

    const user = await db.select().from(users).where(eq(users.id, decoded.id));
    if (user.length === 0) return c.json({ error: 'User not found' }, 404);

    let passwordHash = user[0].password;
    if (currentPassword && newPassword) {
      if (!user[0].password) {
        return c.json({ error: 'No password set on this account' }, 400);
      }
      const validPassword = await bcrypt.compare(currentPassword, user[0].password);
      if (!validPassword) {
        return c.json({ error: 'Invalid current password' }, 400);
      }
      passwordHash = await bcrypt.hash(newPassword, 10);
    }

    const newName = (firstName || lastName) 
      ? `${firstName || ''} ${lastName || ''}`.trim() 
      : user[0].name;

    const patch: Record<string, unknown> = {
      name: newName,
      password: passwordHash,
    };
    if (email !== undefined) patch.email = email;
    if (avatarUrl !== undefined) patch.avatar = avatarUrl;
    if (role !== undefined) patch.role = role;
    if (country !== undefined) patch.country = country;
    if (timezone !== undefined) patch.timezone = timezone;
    if (bio !== undefined) patch.bio = bio;

    const updatedUser = await db.update(users)
      .set(patch as any)
      .where(eq(users.id, decoded.id))
      .returning(userProfileFields);

    return c.json({ message: 'Profile updated', user: updatedUser[0] }, 200);
  } catch (error) {
    console.error('[PUT /me] Error saving profile:', error);
    return c.json({ error: 'Failed to update profile' }, 500);
  }
});

// GET /auth/team — list all members in the authenticated user's organization
auth.get('/team', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number };

    const me = await db.select().from(users).where(eq(users.id, decoded.id)).limit(1);

    if (me.length === 0) return c.json({ error: 'User not found' }, 404);

    const meUser = me[0];
    const orgId = meUser.organizationId;
    if (!orgId) return c.json({ team: [] });

    const teamFields = {
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        portalType: users.portalType,
        isVerified: users.isVerified,
        isActive: users.isActive,
        createdAt: users.createdAt,
      } as const;
    const team = (meUser.portalType ?? 'recruiter') === 'org'
      ? await db
          .select(teamFields)
          .from(accountPortalUsers)
          .innerJoin(users, eq(accountPortalUsers.userId, users.id))
          .where(inArray(
            accountPortalUsers.accountId,
            await getAccessibleAccountIds(meUser.id, orgId, meUser.role),
          ))
      : await db
          .select(teamFields)
          .from(users)
          .where(and(
            eq(users.organizationId, orgId),
            eq(users.portalType, 'recruiter'),
          ));

    return c.json({ team });
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
});

// PATCH /auth/users/:id/role — update a team member's role
auth.patch('/users/:id/role', zValidator('json', z.object({ role: z.string() })), async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number };
    const { role } = c.req.valid('json');
    const targetId = parseInt(c.req.param('id'), 10);

    const me = await db.select().from(users).where(eq(users.id, decoded.id)).limit(1);
    if (!me.length) return c.json({ error: 'User not found' }, 404);
    if (me[0].role !== 'recruiter_admin' && me[0].role !== 'org_admin') {
      return c.json({ error: 'Forbidden: admin access required' }, 403);
    }

    const targetUser = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
    if (!targetUser.length) return c.json({ error: 'Target user not found' }, 404);
    if (!(await canManageTeamUser(me[0], targetUser[0]))) {
      return c.json({ error: 'Target user not in your team' }, 403);
    }

    const inviterPortal = (me[0].portalType ?? 'recruiter') as PortalType;
    const inviterRole = (me[0].role ?? 'recruited_staff') as UserRole;
    const resolvedRole = normalizeInviteRole(role, inviterPortal);
    const inviteError = assertCanInvite(inviterPortal, inviterRole, resolvedRole);
    if (inviteError) return c.json({ error: inviteError }, 400);
    const nextPortal = portalForRole(resolvedRole, inviterPortal);

    const updated = await db
      .update(users)
      .set({ role: resolvedRole, portalType: nextPortal })
      .where(eq(users.id, targetId))
      .returning(userProfileFields);
    return c.json({ message: 'Role updated successfully', user: updated[0] });
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
});

// PATCH /auth/users/:id/status — toggle active/deactivate status
auth.patch('/users/:id/status', zValidator('json', z.object({ isActive: z.number() })), async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number };
    const { isActive } = c.req.valid('json');
    const targetId = parseInt(c.req.param('id'), 10);

    const me = await db.select().from(users).where(eq(users.id, decoded.id)).limit(1);
    if (!me.length) return c.json({ error: 'User not found' }, 404);
    if (me[0].role !== 'recruiter_admin' && me[0].role !== 'org_admin') {
      return c.json({ error: 'Forbidden: admin access required' }, 403);
    }

    const targetUser = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
    if (!targetUser.length) return c.json({ error: 'Target user not found' }, 404);
    if (!(await canManageTeamUser(me[0], targetUser[0]))) {
      return c.json({ error: 'Target user not in your team' }, 403);
    }

    const updated = await db.update(users).set({ isActive }).where(eq(users.id, targetId)).returning(userProfileFields);
    return c.json({ message: 'Status updated successfully', user: updated[0] });
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
});

// POST /auth/resend-invite/:id — resend verification email
auth.post('/resend-invite/:id', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number };
    const targetId = parseInt(c.req.param('id'), 10);

    const me = await db.select().from(users).where(eq(users.id, decoded.id)).limit(1);
    if (!me.length) return c.json({ error: 'User not found' }, 404);
    if (me[0].role !== 'recruiter_admin' && me[0].role !== 'org_admin') {
      return c.json({ error: 'Forbidden: admin access required' }, 403);
    }

    const targetUser = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
    if (!targetUser.length) return c.json({ error: 'Target user not found' }, 404);
    if (!(await canManageTeamUser(me[0], targetUser[0]))) {
      return c.json({ error: 'Target user not in your team' }, 403);
    }
    if (targetUser[0].isVerified === 1) {
      return c.json({ error: 'User is already verified' }, 400);
    }

    const verifyToken = jwt.sign({ email: targetUser[0].email, type: 'verify' }, JWT_SECRET, { expiresIn: '1d' });
    await dispatchEmail(
      () => queueInviteEmail(targetUser[0].email, me[0].name, verifyToken),
      () => sendInviteEmail(targetUser[0].email, me[0].name, verifyToken),
    );

    return c.json({ message: 'Invitation resent successfully' });
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
});

// POST /auth/send-password-otp
auth.post('/send-password-otp', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number };

    const me = await db.select().from(users).where(eq(users.id, decoded.id)).limit(1);
    if (!me.length) return c.json({ error: 'User not found' }, 404);

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 mins

    await db.update(users).set({ passwordOtp: otp, passwordOtpExpiry: expiry }).where(eq(users.id, decoded.id));

    await dispatchEmail(
      () => queuePasswordOtpEmail(me[0].email, otp),
      () => sendPasswordOtpEmail(me[0].email, otp),
    ).catch((err) => {
      console.error('[send-password-otp] email delivery failed (non-fatal):', err);
    });

    return c.json({ message: 'OTP sent to your email address' });
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
});

// POST /auth/verify-otp-change-password
auth.post('/verify-otp-change-password', zValidator('json', z.object({ otp: z.string(), newPassword: z.string().min(6) })), async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number };
    const { otp, newPassword } = c.req.valid('json');

    const me = await db.select().from(users).where(eq(users.id, decoded.id)).limit(1);
    if (!me.length) return c.json({ error: 'User not found' }, 404);

    if (!me[0].passwordOtp || me[0].passwordOtp !== otp) {
      return c.json({ error: 'Invalid OTP' }, 400);
    }
    if (me[0].passwordOtpExpiry && new Date(me[0].passwordOtpExpiry) < new Date()) {
      return c.json({ error: 'OTP expired' }, 400);
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.update(users).set({ password: hashedPassword, passwordOtp: null, passwordOtpExpiry: null }).where(eq(users.id, decoded.id));

    return c.json({ message: 'Password updated successfully' });
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
});

export default auth;
