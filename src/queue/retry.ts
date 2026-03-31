// import type { BackoffStrategy } from 'bullmq';

/**
 * Custom exponential backoff with jitter.
 * Prevents thundering herd when multiple jobs retry simultaneously.
 */
export function exponentialBackoffWithJitter(
    attemptsMade: number,
    baseDelay: number,
): number {
    const exponentialDelay = baseDelay * Math.pow(2, attemptsMade - 1);
    const jitter = Math.random() * exponentialDelay * 0.3; // 30% jitter
    return Math.min(exponentialDelay + jitter, 300000); // cap at 5 minutes
}
