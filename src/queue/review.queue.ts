import { Queue } from 'bullmq';
import { getRedisConnection } from '../config/redis.js';
import { logger } from '../config/logger.js';
import type { ReviewJobData } from '../types/review.types.js';

export const REVIEW_QUEUE_NAME = 'review-queue';

let reviewQueue: Queue<ReviewJobData> | null = null;

export function getReviewQueue(): Queue<ReviewJobData> {
    if (reviewQueue) return reviewQueue;

    reviewQueue = new Queue<ReviewJobData>(REVIEW_QUEUE_NAME, {
        connection: getRedisConnection(),
        defaultJobOptions: {
            removeOnComplete: { count: 1000 },
            removeOnFail: { count: 5000 },
        },
    });

    return reviewQueue;
}

/**
 * Enqueue a PR review job.
 */
export async function enqueueReviewJob(data: ReviewJobData): Promise<string> {
    const queue = getReviewQueue();

    // Use a unique job ID to prevent duplicate reviews for the same commit
    const jobId = `review-${data.repoGithubId}-${data.prNumber}-${data.headSha}`;

    const job = await queue.add('review', data, {
        jobId,
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 5000,
        },
    });

    logger.info(
        {
            jobId: job.id,
            repoFullName: data.repoFullName,
            prNumber: data.prNumber,
            headSha: data.headSha.slice(0, 7),
        },
        'Review job enqueued',
    );

    return job.id!;
}

export async function closeReviewQueue(): Promise<void> {
    if (reviewQueue) {
        await reviewQueue.close();
        reviewQueue = null;
    }
}
