import { db } from '../db/index.js';
import { notifications } from '../db/schema.js';

export type NotificationType = 'info' | 'application' | 'interview' | 'stage_change' | 'success' | 'warning';

type CreateNotificationInput = {
  userId: number;
  title: string;
  body?: string;
  type?: NotificationType | string;
  relatedId?: number | null;
  relatedType?: string;
};

/** Best-effort insert — never fail the parent request if notify fails. */
export async function createNotification(input: CreateNotificationInput): Promise<void> {
  try {
    if (!input.userId || !input.title.trim()) return;
    await db.insert(notifications).values({
      userId: input.userId,
      title: input.title.trim(),
      body: input.body ?? '',
      type: input.type ?? 'info',
      relatedId: input.relatedId ?? null,
      relatedType: input.relatedType ?? '',
      isRead: 0,
    });
  } catch (error) {
    console.error('[notifications] create failed:', error);
  }
}

export async function createNotificationsForUsers(
  userIds: Array<number | null | undefined>,
  payload: Omit<CreateNotificationInput, 'userId'>,
): Promise<void> {
  const unique = [...new Set(userIds.filter((id): id is number => typeof id === 'number' && id > 0))];
  await Promise.all(unique.map((userId) => createNotification({ ...payload, userId })));
}
