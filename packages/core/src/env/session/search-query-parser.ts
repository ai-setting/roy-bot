/**
 * @fileoverview Search Query Parser
 * 
 * Parses search query strings into structured terms for message matching.
 * 
 * Supported syntax:
 * - AND: term1 AND term2 (both required, default behavior)
 * - OR: term1 OR term2 (either required)
 * - NOT: term1 NOT term2 (term1 required, term2 excluded)
 * - Quoted phrases: "exact phrase"
 * - Default: AND (space-separated terms are ANDed together)
 * 
 * @example
 * parseSearchQuery("hello world")        // { required: ["hello", "world"], excluded: [], phrases: [] }
 * parseSearchQuery("hello OR world")    // { required: ["hello", "world"], orMode: true }
 * parseSearchQuery("hello NOT world")   // { required: ["hello"], excluded: ["world"] }
 * parseSearchQuery('"exact phrase"')    // { required: [], excluded: [], phrases: ["exact phrase"] }
 */

export interface ParsedQuery {
  /** Required terms (AND logic by default) */
  required: string[];
  /** Terms to exclude */
  excluded: string[];
  /** Exact phrases to match */
  phrases: string[];
}

/**
 * Parse a search query string into structured terms
 * 
 * @param query - Search query string
 * @returns Parsed query structure
 */
export function parseSearchQuery(query: string): ParsedQuery {
  const result: ParsedQuery = {
    required: [],
    excluded: [],
    phrases: [],
  };

  if (!query || !query.trim()) {
    return result;
  }

  // Step 1: Extract quoted phrases first
  const phraseRegex = /"([^"]+)"/g;
  let match;
  while ((match = phraseRegex.exec(query)) !== null) {
    result.phrases.push(match[1].toLowerCase());
  }
  // Remove quoted phrases from query
  query = query.replace(phraseRegex, "");

  // Step 2: Normalize whitespace
  query = query.replace(/\s+/g, " ").trim();
  
  if (!query) {
    return result;
  }

  // Step 3: Tokenize query by splitting on operators
  // Need to handle each operator separately since they can chain
  const parts: { text: string; operator?: string }[] = [];
  let remaining = query;
  
  // Match single operators one at a time
  const singleOpRegex = /\s+(AND|OR|NOT)\s+/gi;
  let opMatch;
  
  while ((opMatch = singleOpRegex.exec(remaining)) !== null) {
    const op = opMatch[1].toUpperCase();
    const beforeText = remaining.slice(0, opMatch.index).trim();
    
    if (beforeText) {
      parts.push({ text: beforeText, operator: undefined });
    }
    parts.push({ text: op, operator: op });
    
    remaining = remaining.slice(opMatch.index + opMatch[0].length);
    
    // Reset regex lastIndex for remaining portion
    singleOpRegex.lastIndex = 0;
  }
  
  // Remaining text after last operator
  if (remaining.trim()) {
    parts.push({ text: remaining.trim(), operator: undefined });
  }

  // Step 4: Build result
  let currentOperator = "AND";
  
  for (const part of parts) {
    if (part.operator) {
      // This is an operator
      currentOperator = part.operator;
    } else {
      // This is text - split into words
      // Use Unicode-aware word matching (supports Chinese, Japanese, etc.)
      const wordRegex = /[\w\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]+/gu;
      const words = part.text.match(wordRegex) || [];
      
      for (const word of words) {
        const lowerWord = word.toLowerCase();
        
        // Check if this word is an operator
        if (lowerWord === "and" || lowerWord === "or" || lowerWord === "not") {
          currentOperator = lowerWord.toUpperCase();
          continue;
        }
        
        // Apply current operator to this word
        if (currentOperator === "NOT") {
          if (!result.excluded.includes(lowerWord)) {
            result.excluded.push(lowerWord);
          }
        } else {
          if (!result.required.includes(lowerWord)) {
            result.required.push(lowerWord);
          }
        }
        // Reset to AND after processing a word
        currentOperator = "AND";
      }
    }
  }

  return result;
}

/**
 * Check if content matches parsed query
 * 
 * @param content - Content to search
 * @param query - Parsed query structure
 * @returns true if content matches query
 */
export function matchesQuery(content: string, query: ParsedQuery): boolean {
  if (!content) {
    return query.required.length === 0 && query.phrases.length === 0;
  }

  const lowerContent = content.toLowerCase();

  // Step 1: Check excluded terms first (highest priority)
  for (const term of query.excluded) {
    if (lowerContent.includes(term.toLowerCase())) {
      return false;
    }
  }

  // Step 2: Check required phrases
  for (const phrase of query.phrases) {
    if (!lowerContent.includes(phrase)) {
      return false;
    }
  }

  // Step 3: Check required terms (AND logic)
  // If no required terms, match (only exclusions and phrases applied)
  if (query.required.length > 0) {
    for (const term of query.required) {
      if (!lowerContent.includes(term)) {
        return false;
      }
    }
  }

  return true;
}
