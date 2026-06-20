import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import { organizations, users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { sendVerificationEmail, sendInviteEmail, sendPasswordResetEmail } from '../utils/email.js';

const auth = new Hono({ strict: false });
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';

type UserRole = 'recruiter_admin' | 'recruited_staff' | 'org_admin' | 'org_staff';
type PortalType = 'org' | 'recruiter';

const userProfileFields = {
  id: users.id,
  name: users.name,
  email: users.email,
  role: users.role,
  portalType: users.portalType,
  organizationId: users.organizationId,
};

function resolvePortalType(
  portalType?: PortalType,
  accountType?: 'organization' | 'recruiter',
): PortalType {
  if (portalType) return portalType;
  if (accountType === 'recruiter') return 'recruiter';
  return 'org';
}

function roleForPortal(portal: PortalType): UserRole {
  return portal === 'recruiter' ? 'recruiter_admin' : 'org_admin';
}

function normalizeInviteRole(role: string | undefined, portal: PortalType): UserRole {
  const normalized = (role ?? '').toLowerCase().replace(/\s+/g, '_');

  if (portal === 'org') {
    if (normalized === 'org_admin' || normalized === 'admin') return 'org_admin';
    return 'org_staff';
  }

  // recruiter portal
  if (normalized === 'recruiter_admin' || normalized === 'admin') return 'recruiter_admin';
  return 'recruited_staff';
}

const RECRUITER_ROLES: UserRole[] = ['recruiter_admin', 'recruited_staff'];
const ORG_ROLES: UserRole[] = ['org_admin', 'org_staff'];

function assertRoleMatchesPortal(role: UserRole, portal: PortalType): string | null {
  if (portal === 'recruiter' && !RECRUITER_ROLES.includes(role)) {
    return 'Recruiter admins can only invite Recruiter Admin or Recruiter Staff roles.';
  }
  if (portal === 'org' && !ORG_ROLES.includes(role)) {
    return 'Org admins can only invite Org Admin or Org Staff roles.';
  }
  return null;
}

const registerSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Invalid email address"),
  portalType: z.enum(['org', 'recruiter']).optional(),
  accountType: z.enum(['organization', 'recruiter']).optional(),
  organization: z.string().optional(),
});

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
      await sendPasswordResetEmail(email, resetToken).catch((err) => {
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
    if (role !== 'recruiter_admin' && role !== 'org_admin') {
      return c.json({ error: 'Forbidden: admin access required' }, 403);
    }
    if (!user[0].organizationId) return c.json({ error: 'Organization not found' }, 404);

    const body = c.req.valid('json');
    const patch: Record<string, unknown> = {};
    if (body.name != null) patch.name = body.name;
    if (body.logo != null) patch.logo = body.logo;
    if (body.defaults != null) patch.defaults = JSON.stringify(body.defaults);

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

// REGISTER (No Password)
auth.post('/register', zValidator('json', registerSchema), async (c) => {
  try {
    const { name, email, portalType, accountType, organization } = c.req.valid('json');
    const resolvedPortal = resolvePortalType(portalType, accountType);
    const resolvedRole = roleForPortal(resolvedPortal);
    const orgName = organization?.trim() || `${name}'s Organization`;

    const existingUser = await db.select().from(users).where(eq(users.email, email));
    if (existingUser.length > 0) {
      return c.json({ error: 'User already exists' }, 400);
    }

    const [newOrg] = await db.insert(organizations).values({ name: orgName }).returning({ id: organizations.id });

    const newUser = await db.insert(users).values({
      name,
      email,
      password: null,
      isVerified: 0,
      role: resolvedRole,
      portalType: resolvedPortal,
      organizationId: newOrg.id,
    }).returning(userProfileFields);

    const verifyToken = jwt.sign({ email: newUser[0].email, type: 'verify' }, JWT_SECRET, { expiresIn: '1d' });
    const emailSent = await sendVerificationEmail(email, verifyToken);

    return c.json({
      message: 'User registered successfully. Please verify your email.',
      user: newUser[0],
      emailSent,
    }, 201);
  } catch (error) {
    return c.json({ error: 'Internal Server Error' }, 500);
  }
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
    const portal = (inviterUser.portalType ?? 'recruiter') as PortalType;
    const resolvedRole = normalizeInviteRole(inviteRole, portal);
    const portalError = assertRoleMatchesPortal(resolvedRole, portal);
    if (portalError) {
      return c.json({ error: portalError }, 403);
    }

    const newUser = await db.insert(users).values({
      name,
      email,
      password: null,
      isVerified: 0,
      role: resolvedRole,
      portalType: portal,
      organizationId: inviterUser.organizationId,
    }).returning(userProfileFields);

    const verifyToken = jwt.sign({ email: newUser[0].email, type: 'verify' }, JWT_SECRET, { expiresIn: '1d' });
    const emailSent = await sendInviteEmail(email, inviterUser.name, verifyToken);

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
      },
      token,
    }, 200);
  } catch (error) {
    return c.json({ error: 'Internal Server Error' }, 500);
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
  name: z.string().min(2, "Name must be at least 2 characters").optional(),
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
    const { name, currentPassword, newPassword } = c.req.valid('json');

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

    const updatedUser = await db.update(users)
      .set({
        name: name || user[0].name,
        password: passwordHash,
      })
      .where(eq(users.id, decoded.id))
      .returning(userProfileFields);

    return c.json({ message: 'Profile updated', user: updatedUser[0] }, 200);
  } catch (error) {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
});

// GET /auth/team — list all members in the authenticated user's organization
auth.get('/team', async (c) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number };

    const me = await db
      .select({ organizationId: users.organizationId })
      .from(users)
      .where(eq(users.id, decoded.id))
      .limit(1);

    if (me.length === 0) return c.json({ error: 'User not found' }, 404);

    const orgId = me[0].organizationId;
    if (!orgId) return c.json({ team: [] });

    const team = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        portalType: users.portalType,
        isVerified: users.isVerified,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.organizationId, orgId));

    return c.json({ team });
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
});

export default auth;
