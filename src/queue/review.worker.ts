import { Worker, Job } from 'bullmq';
import { REVIEW_QUEUE_NAME } from './review.queue.js';
import { getRedisConnection } from '../config/redis.js';
import { env } from '../config/env.js';
import { logger, createChildLogger } from '../config/logger.js';
import {
    getInstallationOctokit,
    fetchPRMetadata,
    fetchPRDiff,
    fetchPRFiles,
    postReview,
    postIssueComment,
    type PRMetadata,
    type ReviewComment,
} from '../github/app.js';
import { reviewRepo } from '../db/repositories/review.repo.js';
import { repositoryRepo } from '../db/repositories/repository.repo.js';
import type { ReviewJobData } from '../types/review.types.js';

let worker: Worker<ReviewJobData> | null = null;

// ─── Review engine stub ─────────────────────────────────────────────────
// TODO: Replace with real LLM-based review engine from src/llm/reviewer.ts

interface ReviewEngineResult {
    summary: string;
    comments: ReviewComment[];
    promptTokens: number;
    completionTokens: number;
}

/**
 * STUB: This is where the LLM review engine will be called.
 * For now, returns a placeholder response so the pipeline is end-to-end testable.
 *
 * In production, this calls src/llm/reviewer.ts → reviewFiles()
 */
function runReviewEngine(
    _diff: string,
    _files: Array<{ filename: string; status: string; patch: string }>,
    _metadata: PRMetadata,
    _language: string | null,
): Promise<ReviewEngineResult> {
    // ──────────────────────────────────────────────────────────────────
    // Replace this with:
    //   import { reviewFiles } from '../llm/reviewer.js';
    //   const result = await reviewFiles(fileDiffs, metadata.title, metadata.body, language);
    //   return { summary: result.summary, comments: result.comments as ReviewComment[], ... };
    // ──────────────────────────────────────────────────────────────────
    return Promise.resolve({
        summary: '🤖 AXD reviewed this PR. LLM engine not yet connected — this is a test review.',
        comments: [],
        promptTokens: 0,
        completionTokens: 0,
    });
}

// ─── Job processor ──────────────────────────────────────────────────────

async function processReviewJob(job: Job<ReviewJobData>) {
    const { data } = job;
    const [owner, repo] = data.repoFullName.split('/');

    const log = createChildLogger({
        jobId: job.id,
        repo: data.repoFullName,
        pr: data.prNumber,
        attempt: job.attemptsMade + 1,
    });

    const startTime = Date.now();

    // ── Step 1: Look up repo in DB ─────────────────────────────────────

    const repoRecord = await repositoryRepo.findByGithubId(data.repoGithubId);
    if (!repoRecord) {
        log.warn('Repository not found in database, skipping');
        return { status: 'skipped', reason: 'repo_not_found' };
    }

    // ── Step 2: Create review record ───────────────────────────────────

    const review = await reviewRepo.create({
        repositoryId: repoRecord.id,
        prNumber: data.prNumber,
        headSha: data.headSha,
        baseSha: data.baseSha,
        triggerAction: data.action,
        triggeredBy: data.sender,
    });

    await reviewRepo.updateStatus(review.id, 'IN_PROGRESS');

    try {
        // ── Step 3: Authenticate as GitHub App installation ─────────────

        log.info('Authenticating as installation');
        const octokit = await getInstallationOctokit(data.installationId);

        // ── Step 4: Fetch PR metadata ──────────────────────────────────

        log.info('Fetching PR metadata');
        const metadata = await fetchPRMetadata(octokit, owner, repo, data.prNumber);

        // Skip draft PRs (might have been converted after webhook fired)
        if (metadata.draft) {
            log.info('PR is now a draft, skipping');
            await reviewRepo.updateStatus(review.id, 'SKIPPED', {
                summary: 'PR is a draft',
                completedAt: new Date(),
                durationMs: Date.now() - startTime,
            });
            return { status: 'skipped', reason: 'draft' };
        }

        // ── Step 5: Fetch the PR diff ──────────────────────────────────

        log.info('Fetching PR diff');
        const diff = await fetchPRDiff(octokit, owner, repo, data.prNumber);

        if (!diff || diff.trim().length === 0) {
            log.info('Empty diff, skipping');
            await reviewRepo.updateStatus(review.id, 'SKIPPED', {
                summary: 'Empty diff',
                completedAt: new Date(),
                durationMs: Date.now() - startTime,
            });
            return { status: 'skipped', reason: 'empty_diff' };
        }

        // Guard: diff size limit
        if (diff.length > env.MAX_DIFF_SIZE_BYTES) {
            log.warn({ diffSize: diff.length, limit: env.MAX_DIFF_SIZE_BYTES }, 'Diff too large');
            await postIssueComment(
                octokit, owner, repo, data.prNumber,
                `🤖 **AXD** — Skipping review: diff is ${(diff.length / 1024).toFixed(0)}KB (limit: ${(env.MAX_DIFF_SIZE_BYTES / 1024).toFixed(0)}KB).`,
            );
            await reviewRepo.updateStatus(review.id, 'SKIPPED', {
                summary: `Diff too large: ${diff.length} bytes`,
                completedAt: new Date(),
                durationMs: Date.now() - startTime,
            });
            return { status: 'skipped', reason: 'diff_too_large' };
        }

        // ── Step 6: Fetch individual file patches ──────────────────────

        log.info({ fileCount: metadata.changedFiles }, 'Fetching file patches');
        const files = await fetchPRFiles(octokit, owner, repo, data.prNumber);

        // Guard: file count limit
        if (files.length > env.MAX_FILES_PER_REVIEW) {
            log.warn({ fileCount: files.length, limit: env.MAX_FILES_PER_REVIEW }, 'Too many files');
            await postIssueComment(
                octokit, owner, repo, data.prNumber,
                `🤖 **AXD** — Skipping review: PR touches ${files.length} files (limit: ${env.MAX_FILES_PER_REVIEW}).`,
            );
            await reviewRepo.updateStatus(review.id, 'SKIPPED', {
                summary: `Too many files: ${files.length}`,
                completedAt: new Date(),
                durationMs: Date.now() - startTime,
            });
            return { status: 'skipped', reason: 'too_many_files' };
        }

        // ── Step 7: Run the review engine ──────────────────────────────

        log.info('Running review engine');
        const result = await runReviewEngine(diff, files, metadata, data.language);

        // ── Step 8: Post review to GitHub ──────────────────────────────

        if (result.comments.length > 0) {
            log.info({ commentCount: result.comments.length }, 'Posting review with comments');
            await postReview(
                octokit, owner, repo, data.prNumber,
                metadata.headSha,
                formatSummary(result.summary, result.comments.length),
                result.comments,
            );
        } else {
            log.info('No comments to post, posting summary only');
            await postIssueComment(
                octokit, owner, repo, data.prNumber,
                formatSummary(result.summary, 0),
            );
        }

        // ── Step 9: Save results to DB ─────────────────────────────────

        const durationMs = Date.now() - startTime;

        if (result.comments.length > 0) {
            await reviewRepo.addComments(
                review.id,
                result.comments.map((c) => ({
                    path: c.path,
                    line: c.line,
                    side: c.side,
                    body: c.body,
                    severity: 'suggestion' as const,
                    category: 'logic',
                })),
            );
        }

        await reviewRepo.updateStatus(review.id, 'COMPLETED', {
            filesReviewed: files.length,
            commentsPosted: result.comments.length,
            promptTokens: result.promptTokens,
            completionTokens: result.completionTokens,
            durationMs,
            summary: result.summary,
            completedAt: new Date(),
        });

        log.info(
            {
                status: 'completed',
                filesReviewed: files.length,
                commentsPosted: result.comments.length,
                durationMs,
            },
            'Review completed',
        );

        return {
            status: 'completed',
            reviewId: review.id,
            filesReviewed: files.length,
            commentsPosted: result.comments.length,
            durationMs,
        };
    } catch (error) {
        const err = error as Error;
        const durationMs = Date.now() - startTime;

        log.error({ err, durationMs }, 'Review job failed');

        await reviewRepo.updateStatus(review.id, 'FAILED', {
            errorMessage: err.message,
            durationMs,
            completedAt: new Date(),
        });

        // Re-throw so Bull retries the job
        throw error;
    }
}

// ─── Summary formatting ─────────────────────────────────────────────────

function formatSummary(summary: string, commentCount: number): string {
    return [
        '🤖 **AXD — AI Code Review**',
        '',
        summary,
        '',
        '---',
        commentCount > 0
            ? `📊 **${commentCount}** comment${commentCount === 1 ? '' : 's'} posted`
            : '✅ No issues found',
        '',
        '<sub>Powered by Claude • React with 👍/👎 on comments to give feedback</sub>',
    ].join('\n');
}

// ─── Worker lifecycle ───────────────────────────────────────────────────

/**
 * Start the BullMQ worker that processes review jobs.
 */
export function startReviewWorker(): Worker<ReviewJobData> {
    if (worker) return worker;

    worker = new Worker<ReviewJobData>(
        REVIEW_QUEUE_NAME,
        processReviewJob,
        {
            connection: getRedisConnection(),
            concurrency: env.QUEUE_CONCURRENCY,
            limiter: {
                max: env.MAX_REVIEWS_PER_HOUR_PER_INSTALL,
                duration: 3_600_000, // 1 hour
            },
        },
    );

    worker.on('completed', (job) => {
        logger.debug({ jobId: job?.id }, 'Job completed');
    });

    worker.on('failed', (job, err) => {
        logger.error(
            { jobId: job?.id, err, attempt: job?.attemptsMade },
            'Job failed',
        );
    });

    worker.on('error', (err) => {
        logger.error({ err }, 'Worker error');
    });

    logger.info({ concurrency: env.QUEUE_CONCURRENCY }, 'Review worker started');
    return worker;
}

export async function stopReviewWorker(): Promise<void> {
    if (worker) {
        await worker.close();
        worker = null;
        logger.info('Review worker stopped');
    }
}
