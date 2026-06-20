import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { db } from '../db/index.js';
import { notifications, users } from '../db/schema.js';
import { eq, and, desc } from 'drizzle-orm';
import { requireAuth, type AppContext } from '../middleware.js';

const notificationsRouter = new Hono<AppContext>({ strict: false });

// GET /notifications — paginated list + unread count for the current user
notificationsRouter.get('/', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;

    const rows = await db.select().from(notifications)
      .where(eq(notifications.userId, userId))
      .orderBy(desc(notifications.createdAt))
      .limit(50);

    const unreadCount = rows.filter((n: any) => !n.isRead).length;
    return c.json({ notifications: rows, unreadCount });
  } catch {
    return c.json({ error: 'Failed to fetch notifications' }, 500);
  }
});

// POST /notifications/:id/read — mark one notification as read
notificationsRouter.post('/:id/read', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;
    const id     = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid id' }, 400);

    await db.update(notifications)
      .set({ isRead: 1 })
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId)));

    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'Failed to mark as read' }, 500);
  }
});

// POST /notifications/read-all — mark all as read
notificationsRouter.post('/read-all', requireAuth, async (c) => {
  try {
    const userId = c.get('userId') as number;

    await db.update(notifications).set({ isRead: 1 }).where(eq(notifications.userId, userId));
    return c.json({ ok: true });
  } catch {
    return c.json({ error: 'Failed to mark all as read' }, 500);
  }
});

const createSchema = z.object({
  title:       z.string().min(1),
  body:        z.string().optional(),
  type:        z.string().optional(),
  relatedId:   z.number().optional(),
  relatedType: z.string().optional(),
});

// POST /notifications — internal helper: create a notification for a user
// (used by other routes when creating applications, stage changes, etc.)
notificationsRouter.post('/', requireAuth, zValidator('json', createSchema), async (c) => {
  try {
    const userId = c.get('userId') as number;
    const b      = c.req.valid('json');

    const [created] = await db.insert(notifications).values({
      userId:      userId,
      title:       b.title,
      body:        b.body        ?? '',
      type:        b.type        ?? 'info',
      relatedId:   b.relatedId   ?? null,
      relatedType: b.relatedType ?? '',
      isRead:      0,
    }).returning();

    return c.json(created, 201);
  } catch {
    return c.json({ error: 'Failed to create notification' }, 500);
  }
});

export default notificationsRouter;
