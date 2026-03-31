// This module is now superseded by the parsing logic built into client.ts.
// Re-export for backward compatibility with existing imports.

export { LLMParseError } from './client.js';

import { LLMReviewResponseSchema, type LLMReviewResponse } from '../types/review.types.js';
import { logger } from '../config/logger.js';
import { LLMParseError } from './client.js';

/**
 * Standalone parser for use outside the callClaude flow.
 * Useful for testing or processing cached responses.
 */
export function parseLLMResponse(rawContent: string): LLMReviewResponse {
    let cleaned = rawContent.trim();

    // Strip markdown code fences
    if (cleaned.startsWith('```json')) {
        cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith('```')) {
        cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    // Find the JSON object boundaries
    const jsonStart = cleaned.indexOf('{');
    if (jsonStart > 0) cleaned = cleaned.slice(jsonStart);

    const jsonEnd = cleaned.lastIndexOf('}');
    if (jsonEnd >= 0 && jsonEnd < cleaned.length - 1) {
        cleaned = cleaned.slice(0, jsonEnd + 1);
    }

    // Parse JSON
    let parsed: unknown;
    try {
        parsed = JSON.parse(cleaned);
    } catch (error) {
        const err = error as Error;
        logger.warn({ rawContent: rawContent.slice(0, 500), error: err.message }, 'Failed to parse LLM JSON');
        throw new LLMParseError(`Invalid JSON: ${err.message}`, rawContent);
    }

    // Validate against Zod schema
    const result = LLMReviewResponseSchema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ');
        logger.warn({ issues, parsed }, 'LLM response schema validation failed');
        throw new LLMParseError(`Schema validation failed: ${issues}`, rawContent);
    }

    return result.data;
}
