    /**
     * Reusable BunnyCDN Storage utility.
     *
     * Folder structure on the CDN:
     *   hrms-dev/
     *     avatars/        – user profile pictures
     *     logos/           – client/org logos (short + long)
     *     resumes/         – candidate resume PDFs
     *     documents/       – onboarding & general docs
     *     images/          – rich-text editor images
     *     campaigns/       – email campaign attachments
     *
     * Usage:
     *   import { cdn } from '../lib/bunny-cdn.js';
     *   const { cdnUrl } = await cdn.upload('avatars', buffer, 'avatar.png');
     *   await cdn.remove('avatars/avatar.png');
     *   const url = cdn.url('avatars/avatar.png');
     */

    const STORAGE_ZONE = process.env.BUNNY_STORAGE_ZONE ?? '';
    const ACCESS_KEY = process.env.BUNNY_STORAGE_ACCESS_KEY ?? '';
    const STORAGE_ENDPOINT = (process.env.BUNNY_STORAGE_ENDPOINT ?? 'https://storage.bunnycdn.com').replace(/\/$/, '');
    const CDN_URL = (process.env.BUNNY_CDN_URL ?? '').replace(/\/$/, '');

    export type CdnFolder =
      | 'avatars'
      | 'logos'
      | 'resumes'
      | 'documents'
      | 'images'
      | 'campaigns';

    export interface CdnUploadResult {
      /** Storage path relative to zone root, e.g. "avatars/abc.png" */
      storagePath: string;
      /** Public CDN URL for immediate use, e.g. "https://hrms-dev.b-cdn.net/avatars/abc.png" */
      cdnUrl: string;
    }

    function ensureConfigured(): void {
      if (!STORAGE_ZONE || !ACCESS_KEY) {
        throw new Error('[bunny-cdn] Missing BUNNY_STORAGE_ZONE or BUNNY_STORAGE_ACCESS_KEY in env');
      }
    }

    /**
     * Upload a file buffer to BunnyCDN storage.
     *
     * @param folder  – one of the predefined folders (avatars, logos, etc.)
     * @param buffer  – file contents as Buffer or Uint8Array
     * @param filename – destination filename (tip: use a UUID to avoid collisions)
     */
    async function upload(folder: CdnFolder, buffer: Buffer | Uint8Array, filename: string): Promise<CdnUploadResult> {
      ensureConfigured();

      const storagePath = `${folder}/${filename}`;
      const url = `${STORAGE_ENDPOINT}/${STORAGE_ZONE}/${storagePath}`;

  const res = await fetch(url, {
    method: 'PUT',
    signal: AbortSignal.timeout(60_000),
    headers: {
      AccessKey: ACCESS_KEY,
      'Content-Type': 'application/octet-stream',
    },
    body: buffer as unknown as BodyInit,
  });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`[bunny-cdn] Upload failed (${res.status}): ${text}`);
      }

      return {
        storagePath,
        cdnUrl: `${CDN_URL}/${storagePath}`,
      };
    }

    /**
     * Delete a file from BunnyCDN storage.
     *
     * @param storagePath – path relative to zone root, e.g. "avatars/abc.png"
     */
    async function remove(storagePath: string): Promise<void> {
      ensureConfigured();

      const url = `${STORAGE_ENDPOINT}/${STORAGE_ZONE}/${storagePath}`;

      const res = await fetch(url, {
        method: 'DELETE',
        signal: AbortSignal.timeout(60_000),
        headers: { AccessKey: ACCESS_KEY },
      });

      if (!res.ok && res.status !== 404) {
        const text = await res.text().catch(() => '');
        throw new Error(`[bunny-cdn] Delete failed (${res.status}): ${text}`);
      }
    }

    /** Fetch a private object through the authenticated storage API. */
    async function download(storagePath: string): Promise<Buffer> {
      ensureConfigured();
      if (!storagePath || storagePath.includes('..') || storagePath.startsWith('/')) {
        throw new Error('[bunny-cdn] Invalid storage path');
      }
      const url = `${STORAGE_ENDPOINT}/${STORAGE_ZONE}/${storagePath}`;
      const res = await fetch(url, {
        method: 'GET',
        signal: AbortSignal.timeout(60_000),
        headers: { AccessKey: ACCESS_KEY },
      });
      if (!res.ok) {
        throw new Error(`[bunny-cdn] Download failed (${res.status})`);
      }
      return Buffer.from(await res.arrayBuffer());
    }

    /**
     * List files in a CDN folder.
     *
     * @param folder – one of the predefined folders
     */
    async function list(folder: CdnFolder): Promise<Array<{ ObjectName: string; Length: number; LastChanged: string }>> {
      ensureConfigured();

      const apiKey = process.env.BUNNY_API_KEY ?? ACCESS_KEY;
      const url = `${STORAGE_ENDPOINT}/${STORAGE_ZONE}/${folder}/`;

      const res = await fetch(url, {
        method: 'GET',
        headers: { AccessKey: apiKey },
      });

      if (!res.ok) return [];
      return res.json();
    }

    /**
     * Build the public CDN URL for a stored file.
     *
     * @param storagePath – path relative to zone root, e.g. "avatars/abc.png"
     */
    function getUrl(storagePath: string): string {
      return `${CDN_URL}/${storagePath}`;
    }

    /**
     * Check whether CDN is configured (env vars present).
     */
    function isConfigured(): boolean {
      return Boolean(STORAGE_ZONE && ACCESS_KEY && CDN_URL);
    }

    export const cdn = { upload, download, remove, list, getUrl, isConfigured } as const;
