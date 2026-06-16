import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';

/**
 * Shared JWT authentication middleware for Hono routes.
 * Verifies the Bearer token and sets `userId` in the context.
 */
export const requireAuth = async (c: any, next: any) => {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number; email: string };
    c.set('userId', decoded.id);
    await next();
  } catch {
    return c.json({ error: 'Invalid or expired token' }, 401);
  }
};
