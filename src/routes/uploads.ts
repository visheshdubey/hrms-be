import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Hono } from 'hono';
import { requireAuth, type AppContext } from '../middleware.js';
import { db } from '../db/index.js';
import { uploadAssets } from '../db/schema.js';
import { and, eq } from 'drizzle-orm';
import { enqueueUploadTask } from '../queue/upload-queue.js';
import { cdn, type CdnFolder } from '../lib/bunny-cdn.js';
import { canAccessAccountId, isOrgPortalRole } from '../lib/orgScope.js';

const uploadsRouter = new Hono<AppContext>({ strict: false });

const HEAVY_UPLOAD_BYTES = Number(process.env.HEAVY_UPLOAD_BYTES ?? String(1024 * 1024));

const IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

const LOGO_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const LOGO_MAX_BYTES = 2 * 1024 * 1024;

const AVATAR_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

const DOC_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const SHEET_MIME = new Set([
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

function extensionForMime(mime: string): string {
  switch (mime) {
    case 'image/jpeg': return 'jpg';
    case 'image/png': return 'png';
    case 'image/webp': return 'webp';
    case 'application/pdf': return 'pdf';
    case 'application/msword': return 'doc';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': return 'docx';
    case 'text/csv': return 'csv';
    case 'application/vnd.ms-excel': return 'xls';
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': return 'xlsx';
    default: return 'bin';
  }
}

function hasValidImageSignature(buffer: Buffer, mime: string): boolean {
  if (mime === 'image/jpeg') {
    return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (mime === 'image/png') {
    return buffer.length >= 8
      && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mime === 'image/webp') {
    return buffer.length >= 12
      && buffer.toString('ascii', 0, 4) === 'RIFF'
      && buffer.toString('ascii', 8, 12) === 'WEBP';
  }
  return true;
}

/**
 * Generic file upload handler.
 * When BunnyCDN is configured, files go to CDN. Otherwise falls back to local disk.
 */
async function handleUpload(
  file: File,
  folder: CdnFolder,
  allowedMimes: Set<string>,
  maxBytes: number,
  owner: { userId: number; organizationId: number | null; accountId?: number | null },
): Promise<{ url: string; storagePath?: string }> {
  if (!allowedMimes.has(file.type)) {
    throw Object.assign(new Error('Unsupported file type'), { status: 400 });
  }
  if (file.size > maxBytes) {
    throw Object.assign(new Error(`File must be under ${Math.round(maxBytes / 1024 / 1024)}MB`), { status: 400 });
  }

  const ext = extensionForMime(file.type);
  const filename = `${randomUUID()}.${ext}`;
  const buffer = Buffer.from(await file.arrayBuffer());
  if (file.type.startsWith('image/') && !hasValidImageSignature(buffer, file.type)) {
    throw Object.assign(new Error('File content does not match its image type'), { status: 400 });
  }

  if (cdn.isConfigured()) {
    const result = await cdn.upload(folder, buffer, filename);
    await db.insert(uploadAssets).values({
      storagePath: result.storagePath,
      url: result.cdnUrl,
      createdBy: owner.userId,
      organizationId: owner.organizationId,
      accountId: owner.accountId ?? null,
    });
    return { url: result.cdnUrl, storagePath: result.storagePath };
  }

  const uploadDir = path.join(process.cwd(), 'uploads', folder);
  await mkdir(uploadDir, { recursive: true });
  await writeFile(path.join(uploadDir, filename), buffer);
  const storagePath = `${folder}/${filename}`;
  const url = `/uploads/${storagePath}`;
  await db.insert(uploadAssets).values({
    storagePath,
    url,
    createdBy: owner.userId,
    organizationId: owner.organizationId,
    accountId: owner.accountId ?? null,
  });
  return { url, storagePath };
}

// POST /uploads/images — editor & general images → CDN "images" folder
uploadsRouter.post('/images', requireAuth, async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body.file;

    if (!file || !(file instanceof File)) {
      return c.json({ error: 'Image file is required' }, 400);
    }

    const userId = c.get('userId') as number;
    const organizationId = c.get('organizationId') as number | null;

    const { url, storagePath } = await handleUpload(
      file, 'images', IMAGE_MIME, IMAGE_MAX_BYTES, { userId, organizationId },
    );

    let uploadTaskId: string | undefined;
    if (!cdn.isConfigured() && file.size >= HEAVY_UPLOAD_BYTES) {
      const localPath = path.join(process.cwd(), 'uploads', 'images', path.basename(url));
      const { taskId, queued } = await enqueueUploadTask({
        type: 'heavy_upload',
        userId,
        organizationId,
        fileName: path.basename(url),
        filePath: localPath,
        byteSize: file.size,
        metadata: { mime: file.type },
      });
      uploadTaskId = taskId;
      if (!queued) {
        console.warn(`[uploads] heavy file saved inline (Redis unavailable)`);
      }
    }

    return c.json({
      url,
      ...(storagePath ? { storagePath } : {}),
      ...(uploadTaskId ? { uploadTaskId, queued: true } : {}),
    });
  } catch (error: any) {
    if (error?.status === 400) return c.json({ error: error.message }, 400);
    console.error('Image upload failed:', error);
    return c.json({ error: 'Failed to upload image' }, 500);
  }
});

// POST /uploads/avatars — profile pictures → CDN "avatars" folder
uploadsRouter.post('/avatars', requireAuth, async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!file || !(file instanceof File)) {
      return c.json({ error: 'Avatar file is required' }, 400);
    }
    const { url } = await handleUpload(file, 'avatars', AVATAR_MIME, AVATAR_MAX_BYTES, {
      userId: c.get('userId') as number,
      organizationId: c.get('organizationId') as number | null,
    });
    return c.json({ url });
  } catch (error: any) {
    if (error?.status === 400) return c.json({ error: error.message }, 400);
    console.error('Avatar upload failed:', error);
    return c.json({ error: 'Failed to upload avatar' }, 500);
  }
});

// POST /uploads/logos — client/org logos → CDN "logos" folder
uploadsRouter.post('/logos', requireAuth, async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!file || !(file instanceof File)) {
      return c.json({ error: 'Logo file is required' }, 400);
    }
    const accountIdRaw = body.accountId;
    const accountId = typeof accountIdRaw === 'string' ? Number(accountIdRaw) : null;
    if (accountIdRaw != null && (!Number.isInteger(accountId) || Number(accountId) <= 0)) {
      return c.json({ error: 'Invalid account id' }, 400);
    }
    const userId = c.get('userId') as number;
    const organizationId = c.get('organizationId') as number | null;
    const userRole = c.get('userRole') as string | null;
    if (isOrgPortalRole(userRole) && userRole !== 'org_admin') {
      return c.json({ error: 'Only client administrators can upload company logos' }, 403);
    }
    if (isOrgPortalRole(userRole) && accountId == null) {
      return c.json({ error: 'Client logo uploads require an account' }, 400);
    }
    if (
      accountId != null
      && !(await canAccessAccountId(accountId, userId, organizationId, userRole))
    ) {
      return c.json({ error: 'Account not found' }, 404);
    }
    const { url, storagePath } = await handleUpload(file, 'logos', LOGO_MIME, LOGO_MAX_BYTES, {
      userId,
      organizationId,
      accountId,
    });
    return c.json({ url, ...(storagePath ? { storagePath } : {}) });
  } catch (error: any) {
    if (error?.status === 400) return c.json({ error: error.message }, 400);
    console.error('Logo upload failed:', error);
    return c.json({ error: 'Failed to upload logo' }, 500);
  }
});

// POST /uploads/resumes — candidate resumes → CDN "resumes" folder
uploadsRouter.post('/resumes', requireAuth, async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!file || !(file instanceof File)) {
      return c.json({ error: 'Resume file is required' }, 400);
    }
    const { url } = await handleUpload(file, 'resumes', DOC_MIME, 10 * 1024 * 1024, {
      userId: c.get('userId') as number,
      organizationId: c.get('organizationId') as number | null,
    });
    return c.json({ url });
  } catch (error: any) {
    if (error?.status === 400) return c.json({ error: error.message }, 400);
    console.error('Resume upload failed:', error);
    return c.json({ error: 'Failed to upload resume' }, 500);
  }
});

// POST /uploads/documents — onboarding / general docs → CDN "documents" folder
uploadsRouter.post('/documents', requireAuth, async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body.file;
    if (!file || !(file instanceof File)) {
      return c.json({ error: 'Document file is required' }, 400);
    }
    const { url } = await handleUpload(file, 'documents', DOC_MIME, 10 * 1024 * 1024, {
      userId: c.get('userId') as number,
      organizationId: c.get('organizationId') as number | null,
    });
    return c.json({ url });
  } catch (error: any) {
    if (error?.status === 400) return c.json({ error: error.message }, 400);
    console.error('Document upload failed:', error);
    return c.json({ error: 'Failed to upload document' }, 500);
  }
});

// DELETE /uploads/file — remove a file from CDN by storagePath
uploadsRouter.delete('/file', requireAuth, async (c) => {
  try {
    const { storagePath } = await c.req.json<{ storagePath: string }>();
    if (!storagePath) return c.json({ error: 'storagePath is required' }, 400);
    if (!cdn.isConfigured()) return c.json({ error: 'CDN not configured' }, 501);
    const userId = c.get('userId') as number;
    const [asset] = await db.select({ storagePath: uploadAssets.storagePath })
      .from(uploadAssets)
      .where(and(eq(uploadAssets.storagePath, storagePath), eq(uploadAssets.createdBy, userId)))
      .limit(1);
    if (!asset) return c.json({ error: 'File not found' }, 404);
    await cdn.remove(storagePath);
    await db.delete(uploadAssets)
      .where(and(eq(uploadAssets.storagePath, storagePath), eq(uploadAssets.createdBy, userId)));
    return c.json({ ok: true });
  } catch (error) {
    console.error('File delete failed:', error);
    return c.json({ error: 'Failed to delete file' }, 500);
  }
});

const LOCAL_FOLDERS = new Set(['images', 'logos', 'avatars', 'resumes', 'documents']);

function contentTypeForExt(ext: string): string {
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.svg': return 'image/svg+xml';
    case '.pdf': return 'application/pdf';
    default: return 'application/octet-stream';
  }
}

async function serveLocalUpload(folder: string, filename: string): Promise<Response> {
  if (!LOCAL_FOLDERS.has(folder)) {
    return Response.json({ error: 'Invalid folder' }, { status: 400 });
  }
  if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return Response.json({ error: 'Invalid filename' }, { status: 400 });
  }

  const filePath = path.join(process.cwd(), 'uploads', folder, filename);
  const buffer = await readFile(filePath);
  const contentType = contentTypeForExt(path.extname(filename).toLowerCase());

  return new Response(buffer, {
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

// GET /uploads/:folder/:filename — serve locally stored uploads (fallback when CDN is off)
uploadsRouter.get('/:folder/:filename', async (c) => {
  try {
    return await serveLocalUpload(c.req.param('folder'), c.req.param('filename'));
  } catch {
    return c.json({ error: 'File not found' }, 404);
  }
});

export default uploadsRouter;
