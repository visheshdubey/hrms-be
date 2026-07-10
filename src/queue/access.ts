import { belongsToOrganization } from '../lib/orgScope.js';
import type { BatchJobStatus } from './types.js';

/** Prevent cross-org batch status leaks (UUID guessing). */
export function canAccessBatch(
  batch: BatchJobStatus,
  userId: number,
  orgId: number | null,
): boolean {
  if (batch.createdBy != null) {
    return belongsToOrganization(batch.organizationId, orgId, batch.createdBy, userId);
  }
  // Legacy batches without ownership metadata — deny by default
  return false;
}
