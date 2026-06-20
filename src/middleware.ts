import jwt from 'jsonwebtoken';
import { db } from './db/index.js';
import { users } from './db/schema.js';
import { eq } from 'drizzle-orm';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';

export type UserRole = 'recruiter_admin' | 'recruited_staff' | 'org_admin' | 'org_staff';

/** Shared Hono context variables populated by requireAuth */
export type AppContext = {
  Variables: {
    userId: number;
    organizationId: number | null;
    userRole: UserRole | null;
  };
};

/**
 * Verifies the Bearer token, then loads the user's organizationId and role
 * from the DB so downstream route handlers can scope queries correctly.
 */
export const requireAuth = async (c: any, next: any) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number; email: string };

    const row = await db
      .select({ organizationId: users.organizationId, role: users.role })
      .from(users)
      .where(eq(users.id, decoded.id))
      .limit(1);

    if (row.length === 0) {
      return c.json({ error: 'User not found' }, 401);
    }

    c.set('userId', decoded.id);
    c.set('organizationId', row[0].organizationId ?? null);
    c.set('userRole', (row[0].role ?? null) as UserRole | null);
    await next();
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
};

/**
 * Role guard — must be placed after requireAuth.
 * Returns 403 if the authenticated user's role is not in the allowed list.
 *
 * @example
 *   router.delete('/:id', requireAuth, requireRole('recruiter_admin', 'org_admin'), handler)
 */
export const requireRole = (...allowedRoles: UserRole[]) =>
  async (c: any, next: any) => {
    const role = c.get('userRole') as UserRole | null;
    if (!role || !allowedRoles.includes(role)) {
      return c.json({ error: 'Forbidden: insufficient permissions' }, 403);
    }
    await next();
  };
