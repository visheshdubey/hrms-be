import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { uploadAssets } from '../db/schema.js';

type BrandingAssetScope = {
  organizationId: number | null;
  accountId?: number | null;
};

/**
 * Branding may only reference a logo uploaded for the same tenant scope.
 * Existing legacy URLs are handled by callers by skipping validation when
 * the value has not changed.
 */
export async function isAuthorizedBrandingAssetUrl(
  url: string,
  scope: BrandingAssetScope,
): Promise<boolean> {
  const normalizedUrl = url.trim();
  if (!normalizedUrl) return true;
  if (scope.organizationId == null) return false;
  const urlCandidates = [normalizedUrl];
  try {
    const pathname = new URL(normalizedUrl).pathname;
    if (pathname.startsWith('/uploads/')) urlCandidates.push(pathname);
  } catch {
    // Relative upload URL; exact value is already included.
  }

  const accountScope =
    scope.accountId == null
      ? isNull(uploadAssets.accountId)
      : eq(uploadAssets.accountId, scope.accountId);
  const [asset] = await db
    .select({ storagePath: uploadAssets.storagePath })
    .from(uploadAssets)
    .where(and(
      inArray(uploadAssets.url, [...new Set(urlCandidates)]),
      eq(uploadAssets.organizationId, scope.organizationId),
      accountScope,
    ))
    .limit(1);

  return Boolean(asset);
}
