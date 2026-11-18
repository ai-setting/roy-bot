/**
 * @fileoverview ID Generation Utilities
 */

/**
 * Generate a unique ID with optional prefix
 */
export function generateId(prefix: string = "id"): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 11);
  return `${prefix}_${timestamp}_${random}`;
}

/**
 * Generate a descending ID (useful for creating IDs that sort newest first)
 */
export function generateDescendingId(prefix: string = "id"): string {
  const timestamp = (Number.MAX_SAFE_INTEGER - Date.now()).toString(36);
  const random = Math.random().toString(36).substring(2, 11);
  return `${prefix}_${timestamp}_${random}`;
}
