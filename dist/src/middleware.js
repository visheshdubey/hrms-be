import jwt from 'jsonwebtoken';
import { db } from './db/index.js';
import { users } from './db/schema.js';
import { eq } from 'drizzle-orm';
import { JWT_SECRET } from './config.js';
/**
 * Verifies the Bearer token, then loads the user's organizationId and role
 * from the DB so downstream route handlers can scope queries correctly.
 */
export const requireAuth = async (c, next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
        return c.json({ error: 'Unauthorized' }, 401);
    }
    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
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
        c.set('userRole', (row[0].role ?? null));
        await next();
    }
    catch {
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
export const requireRole = (...allowedRoles) => async (c, next) => {
    const role = c.get('userRole');
    if (!role || !allowedRoles.includes(role)) {
        return c.json({ error: 'Forbidden: insufficient permissions' }, 403);
    }
    await next();
};
