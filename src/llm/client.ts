import OpenAI from 'openai';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { LLMReviewResponseSchema, type LLMReviewResponse } from '../types/review.types.js';

// ─── Client singleton ───────────────────────────────────────────────────

let client: OpenAI | null = null;

function getClient(): OpenAI {
    if (client) return client;
    client = new OpenAI({
        apiKey: env.XAI_API_KEY,
        baseURL: 'https://api.x.ai/v1',
        timeout: env.XAI_TIMEOUT_MS,
        maxRetries: 0,  // We handle retries ourselves for JSON repair logic
    });
    return client;
}

// ─── Types ──────────────────────────────────────────────────────────────

export interface CallLLMResult {
    response: LLMReviewResponse;
    promptTokens: number;
    completionTokens: number;
    model: string;
    attempts: number;
    totalLatencyMs: number;
}

interface RawLLMResult {
    content: string;
    promptTokens: number;
    completionTokens: number;
    model: string;
    latencyMs: number;
}

// ─── Error classes ──────────────────────────────────────────────────────

export class LLMParseError extends Error {
    constructor(
        message: string,
        public readonly rawContent: string,
    ) {
        super(message);
        this.name = 'LLMParseError';
    }
}

export class LLMCallError extends Error {
    public readonly statusCode?: number;
    public readonly isRetryable: boolean;

    constructor(message: string, statusCode?: number, isRetryable = false) {
        super(message);
        this.name = 'LLMCallError';
        this.statusCode = statusCode;
        this.isRetryable = isRetryable;
    }
}

// ─── Core: callGrok ───────────────────────────────────────────────────

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 15000;

/**
 * Call Grok with the review prompt. Handles:
 *  1. Exponential backoff retries (3x) for transient API errors
 *  2. JSON parsing with markdown fence stripping
 *  3. Zod schema validation
 *  4. On parse failure: sends a repair prompt to Grok for self-correction
 *  5. Comprehensive token usage logging
 *
 * Returns validated LLMReviewResponse or throws after all retries exhausted.
 */
export async function callGrok(
    systemPrompt: string,
    userPrompt: string,
    repairPromptBuilder?: (malformed: string, error: string) => string,
): Promise<CallLLMResult> {
    const overallStart = Date.now();
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let lastModel = '';
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // ── Step 1: Call Grok API ────────────────────────────────

            const raw = await callGrokRaw(systemPrompt, userPrompt);
            totalPromptTokens += raw.promptTokens;
            totalCompletionTokens += raw.completionTokens;
            lastModel = raw.model;

            logger.info(
                {
                    attempt,
                    model: raw.model,
                    promptTokens: raw.promptTokens,
                    completionTokens: raw.completionTokens,
                    latencyMs: raw.latencyMs,
                },
                'Grok API call completed',
            );

            // ── Step 2: Parse JSON ────────────────────────────────────

            const parsed = parseResponse(raw.content);

            // ── Step 3: Validate with Zod ─────────────────────────────

            const validated = validateResponse(parsed);

            return {
                response: validated,
                promptTokens: totalPromptTokens,
                completionTokens: totalCompletionTokens,
                model: lastModel,
                attempts: attempt,
                totalLatencyMs: Date.now() - overallStart,
            };
        } catch (error) {
            lastError = error as Error;

            // ── JSON/schema failure: try repair prompt ────────────────

            if (error instanceof LLMParseError && repairPromptBuilder && attempt < MAX_RETRIES) {
                logger.warn(
                    { attempt, error: error.message },
                    'Grok returned invalid JSON, sending repair prompt',
                );

                try {
                    const repairPrompt = repairPromptBuilder(error.rawContent, error.message);
                    const repairResult = await callGrokRaw(systemPrompt, repairPrompt);
                    totalPromptTokens += repairResult.promptTokens;
                    totalCompletionTokens += repairResult.completionTokens;
                    lastModel = repairResult.model;

                    const reparsed = parseResponse(repairResult.content);
                    const revalidated = validateResponse(reparsed);

                    logger.info({ attempt }, 'Repair prompt succeeded');
                    return {
                        response: revalidated,
                        promptTokens: totalPromptTokens,
                        completionTokens: totalCompletionTokens,
                        model: lastModel,
                        attempts: attempt,
                        totalLatencyMs: Date.now() - overallStart,
                    };
                } catch (repairError) {
                    logger.warn({ attempt, error: (repairError as Error).message }, 'Repair prompt also failed');
                    // Fall through to retry loop
                }
            }

            // ── API error: check if retryable ─────────────────────────

            if (error instanceof LLMCallError && !error.isRetryable) {
                logger.error({ err: error, attempt }, 'Non-retryable Grok API error');
                throw error;
            }

            // ── Exponential backoff ───────────────────────────────────

            if (attempt < MAX_RETRIES) {
                const delay = Math.min(
                    BASE_DELAY_MS * Math.pow(2, attempt - 1) + Math.random() * 500,
                    MAX_DELAY_MS,
                );
                logger.warn(
                    { attempt, delayMs: delay, error: (error as Error).message },
                    'Retrying Grok call after delay',
                );
                await sleep(delay);
            }
        }
    }

    // All retries exhausted
    const totalMs = Date.now() - overallStart;
    logger.error(
        {
            totalMs,
            totalPromptTokens,
            totalCompletionTokens,
            lastError: lastError?.message,
        },
        'All Grok retry attempts exhausted',
    );

    throw lastError ?? new LLMCallError('Unknown error after all retries');
}

// ─── Raw API call ───────────────────────────────────────────────────────

async function callGrokRaw(
    systemPrompt: string,
    userPrompt: string,
): Promise<RawLLMResult> {
    const openai = getClient();
    const start = Date.now();

    try {
        const response = await openai.chat.completions.create({
            model: env.XAI_MODEL,
            max_tokens: env.XAI_MAX_TOKENS,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ]
        });

        const content = response.choices[0]?.message?.content || '';

        return {
            content,
            promptTokens: response.usage?.prompt_tokens || 0,
            completionTokens: response.usage?.completion_tokens || 0,
            model: response.model,
            latencyMs: Date.now() - start,
        };
    } catch (error) {
        const latencyMs = Date.now() - start;
        const err = error as { status?: number; message?: string; error?: { type?: string } };

        // Classify error for retry logic
        const statusCode = err.status;
        const isRetryable = statusCode === 429     // Rate limited
            || statusCode === 500                     // Server error
            || statusCode === 502                     // Bad gateway
            || statusCode === 503                     // Service unavailable
            || statusCode === 529;                    // Overloaded

        logger.error(
            { statusCode, latencyMs, errorType: err.error?.type },
            'Grok API request failed',
        );

        throw new LLMCallError(
            err.message ?? 'Grok API call failed',
            statusCode,
            isRetryable,
        );
    }
}

// ─── Response parsing ───────────────────────────────────────────────────

/**
 * Parse Grok's string output into JSON, stripping any markdown fences.
 */
function parseResponse(raw: string): unknown {
    let cleaned = raw.trim();

    // Strip markdown code fences (LLMs sometimes add them despite instructions)
    if (cleaned.startsWith('```json')) {
        cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith('```')) {
        cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    // Strip any leading text before the first {
    const jsonStart = cleaned.indexOf('{');
    if (jsonStart > 0) {
        logger.debug(
            { prefixLength: jsonStart },
            'Stripping non-JSON prefix from Grok response',
        );
        cleaned = cleaned.slice(jsonStart);
    }

    // Strip any trailing text after the last }
    const jsonEnd = cleaned.lastIndexOf('}');
    if (jsonEnd >= 0 && jsonEnd < cleaned.length - 1) {
        cleaned = cleaned.slice(0, jsonEnd + 1);
    }

    try {
        return JSON.parse(cleaned);
    } catch (error) {
        throw new LLMParseError(
            `Invalid JSON: ${(error as Error).message}`,
            raw,
        );
    }
}

/**
 * Validate parsed JSON against the Zod schema.
 */
function validateResponse(parsed: unknown): LLMReviewResponse {
    const result = LLMReviewResponseSchema.safeParse(parsed);

    if (!result.success) {
        const issues = result.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ');

        logger.warn({ issues }, 'Grok response failed Zod validation');

        throw new LLMParseError(
            `Schema validation failed: ${issues}`,
            JSON.stringify(parsed).slice(0, 3000),
        );
    }

    return result.data;
}

// ─── Utility ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
