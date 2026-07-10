import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { requireAuth, type AppContext } from '../middleware.js';
import { enqueueUploadTask } from '../queue/upload-queue.js';

const uploadsRouter = new Hono<AppContext>({ strict: false });

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Files above this size are also enqueued for async processing (stub worker). */
const HEAVY_UPLOAD_BYTES = Number(process.env.HEAVY_UPLOAD_BYTES ?? String(1024 * 1024));
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml']);

function extensionForMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/svg+xml':
      return 'svg';
    default:
      return 'img';
  }
}

// POST /uploads/images — store editor images and return a public URL
uploadsRouter.post('/images', requireAuth, async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body.file;

    if (!file || !(file instanceof File)) {
      return c.json({ error: 'Image file is required' }, 400);
    }

    if (!ALLOWED_MIME.has(file.type)) {
      return c.json({ error: 'Unsupported image type' }, 400);
    }

    if (file.size > MAX_IMAGE_BYTES) {
      return c.json({ error: 'Image must be under 5MB' }, 400);
    }

    const ext = extensionForMime(file.type);
    const filename = `${randomUUID()}.${ext}`;
    const uploadDir = path.join(process.cwd(), 'uploads', 'images');
    await mkdir(uploadDir, { recursive: true });

    const buffer = Buffer.from(await file.arrayBuffer());
    const filePath = path.join(uploadDir, filename);
    await writeFile(filePath, buffer);

    const userId = c.get('userId') as number;
    const organizationId = c.get('organizationId') as number | null;

    let uploadTaskId: string | undefined;
    if (file.size >= HEAVY_UPLOAD_BYTES) {
      const { taskId, queued } = await enqueueUploadTask({
        type: 'heavy_upload',
        userId,
        organizationId,
        fileName: filename,
        filePath,
        byteSize: file.size,
        metadata: { mime: file.type },
      });
      uploadTaskId = taskId;
      if (!queued) {
        console.warn(`[uploads] heavy file saved inline (Redis unavailable): ${filename}`);
      }
    }

    return c.json({
      url: `/uploads/images/${filename}`,
      ...(uploadTaskId ? { uploadTaskId, queued: true } : {}),
    });
  } catch (error) {
    console.error('Image upload failed:', error);
    return c.json({ error: 'Failed to upload image' }, 500);
  }
});

// GET /uploads/images/:filename — serve uploaded images
uploadsRouter.get('/images/:filename', async (c) => {
  try {
    const filename = c.req.param('filename');
    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return c.json({ error: 'Invalid filename' }, 400);
    }

    const filePath = path.join(process.cwd(), 'uploads', 'images', filename);
    const buffer = await readFile(filePath);

    const ext = path.extname(filename).toLowerCase();
    const contentType =
      ext === '.png' ? 'image/png'
      : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : ext === '.gif' ? 'image/gif'
      : ext === '.webp' ? 'image/webp'
      : ext === '.svg' ? 'image/svg+xml'
      : 'application/octet-stream';

    return new Response(buffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return c.json({ error: 'Image not found' }, 404);
  }
});

export default uploadsRouter;
