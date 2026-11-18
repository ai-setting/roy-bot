/**
 * @fileoverview Node ID utility functions
 * 
 * Provides shared utilities for node ID handling, including
 * hyphen/underscore normalization for flexible node ID matching.
 */

/**
 * Get a value from a Map with hyphen/underscore normalization.
 * 
 * First tries exact match, then tries replacing hyphens with underscores,
 * then tries replacing underscores with hyphens.
 * 
 * This handles cases where workflow defines a node with underscore but
 * a template uses hyphen, or vice versa.
 * 
 * @param map - The Map to search in
 * @param key - The key to look up
 * @returns The value if found, undefined otherwise
 */
export function getFromMapWithNormalization<V>(
  map: Map<string, V>,
  key: string
): V | undefined {
  // Try exact match first
  let value = map.get(key);
  if (value !== undefined) {
    return value;
  }

  // Try normalized versions for flexibility
  const normalizedUnderscore = key.replace(/-/g, '_');
  const normalizedHyphen = key.replace(/_/g, '-');

  if (normalizedUnderscore !== key) {
    value = map.get(normalizedUnderscore);
  }
  if (value === undefined && normalizedHyphen !== key) {
    value = map.get(normalizedHyphen);
  }

  return value;
}
