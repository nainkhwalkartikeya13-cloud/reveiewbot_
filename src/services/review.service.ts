import { getInstallationOctokit } from '../github/app.js';
import { fetchPRDiff, parseDiff, filterFiles } from '../github/diff.js';
import { postReviewComments, postPRComment } from '../github/comments.js';
import { reviewFiles } from '../llm/reviewer.js';
import { reviewRepo } from '../db/repositories/review.repo.js';
import { repositoryRepo } from '../db/repositories/repository.repo.js';
import { configService } from './config.service.js';
import { usageService } from './usage.service.js';
import { env } from '../config/env.js';
import { createChildLogger } from '../config/logger.js';
import type { ReviewJobData, ReviewResult } from '../types/review.types.js';

class ReviewService {
    /**
     * Process a full PR review: fetch diff → filter files → call LLM → post comments → save results.
     */
    async processReview(jobData: ReviewJobData): Promise<ReviewResult> {
        const log = createChildLogger({
            repoFullName: jobData.repoFullName,
            prNumber: jobData.prNumber,
        });

        const startTime = Date.now();
        const [owner, repo] = jobData.repoFullName.split('/');

        // 1. Find repository record
        const repoRecord = await repositoryRepo.findByGithubId(jobData.repoGithubId);
        if (!repoRecord) {
            log.warn('Repository not found in DB');
            return this.skipResult('Repository not found');
        }

        // 2. Create review record
        const review = await reviewRepo.create({
            repositoryId: repoRecord.id,
            prNumber: jobData.prNumber,
            headSha: jobData.headSha,
            baseSha: jobData.baseSha,
            triggerAction: jobData.action,
            triggeredBy: jobData.sender,
        });

        try {
            // 3. Update status to IN_PROGRESS
            await reviewRepo.updateStatus(review.id, 'IN_PROGRESS');

            // 4. Get authenticated Octokit for this installation
            const octokit = await getInstallationOctokit(jobData.installationId);

            // 5. Fetch and parse diff
            const rawDiff = await fetchPRDiff(octokit, owner, repo, jobData.prNumber);

            if (!rawDiff || rawDiff.length === 0) {
                return this.completeReview(review.id, startTime, {
                    status: 'skipped',
                    summary: 'No diff content found.',
                });
            }

            // Check diff size limit
            if (rawDiff.length > env.MAX_DIFF_SIZE_BYTES) {
                await postPRComment(
                    octokit,
                    owner,
                    repo,
                    jobData.prNumber,
                    '🤖 **AXD**: Skipping review — diff is too large for analysis.',
                );
                return this.completeReview(review.id, startTime, {
                    status: 'skipped',
                    summary: 'Diff exceeds size limit.',
                });
            }

            // 6. Parse diff into file objects
            const allFiles = parseDiff(rawDiff);

            // 7. Filter files based on repo config
            const repoConfig = configService.getConfig(repoRecord.config);
            const files = filterFiles(allFiles, repoConfig.includeGlobs, repoConfig.excludeGlobs ?? repoConfig.ignore_paths);

            if (files.length === 0) {
                return this.completeReview(review.id, startTime, {
                    status: 'skipped',
                    summary: 'No reviewable files after filtering.',
                });
            }

            // Check file count limit
            const maxFiles = repoConfig.maxFilesPerReview ?? repoConfig.max_files_per_review;
            if (files.length > maxFiles) {
                await postPRComment(
                    octokit,
                    owner,
                    repo,
                    jobData.prNumber,
                    `🤖 **AXD**: Skipping review — PR touches ${files.length} files (limit: ${repoConfig.maxFilesPerReview}).`,
                );
                return this.completeReview(review.id, startTime, {
                    status: 'skipped',
                    summary: `Too many files: ${files.length} > ${repoConfig.maxFilesPerReview}`,
                });
            }

            log.info({ fileCount: files.length }, 'Starting LLM review');

            // 8. Call LLM for review
            const reviewOutput = await reviewFiles(
                files,
                jobData.title,
                jobData.body,
                jobData.language,
                repoConfig.customInstructions,
            );

            // 9. Filter comments by severity threshold
            const severityOrder = ['critical', 'warning', 'suggestion', 'nitpick'] as const;
            const thresholdIdx = severityOrder.indexOf(repoConfig.severityThreshold ?? 'suggestion');
            const filteredComments = reviewOutput.comments.filter(
                (c) => severityOrder.indexOf(c.severity) <= thresholdIdx,
            );

            // 10. Post comments to GitHub
            if (filteredComments.length > 0) {
                const reviewComments = filteredComments.map((c) => ({
                    path: c.path,
                    line: c.line,
                    side: c.side,
                    body: c.body,
                }));
                await postReviewComments(
                    octokit,
                    owner,
                    repo,
                    jobData.prNumber,
                    jobData.headSha,
                    reviewOutput.summary,
                    reviewComments,
                );
            } else {
                // Post summary-only comment if no issues found
                await postPRComment(
                    octokit,
                    owner,
                    repo,
                    jobData.prNumber,
                    `🤖 **AXD — AI Code Review**\n\n${reviewOutput.summary}\n\n✅ No issues found.`,
                );
            }

            // 11. Save comments to DB
            if (filteredComments.length > 0) {
                await reviewRepo.addComments(review.id, filteredComments);
            }

            // 12. Track usage
            const installationRecord = await (
                await import('../db/repositories/installation.repo.js')
            ).installationRepo.findByGithubId(jobData.installationId);

            if (installationRecord) {
                await usageService.trackUsage(
                    installationRecord.id,
                    reviewOutput.totalPromptTokens,
                    reviewOutput.totalCompletionTokens,
                );
            }

            // 13. Complete review
            const durationMs = Date.now() - startTime;
            await reviewRepo.updateStatus(review.id, 'COMPLETED', {
                filesReviewed: files.length,
                commentsPosted: filteredComments.length,
                promptTokens: reviewOutput.totalPromptTokens,
                completionTokens: reviewOutput.totalCompletionTokens,
                durationMs,
                summary: reviewOutput.summary,
                completedAt: new Date(),
            });

            return {
                reviewId: review.id,
                status: 'completed',
                filesReviewed: files.length,
                commentsPosted: filteredComments.length,
                promptTokens: reviewOutput.totalPromptTokens,
                completionTokens: reviewOutput.totalCompletionTokens,
                durationMs,
                summary: reviewOutput.summary,
                errorMessage: null,
            };
        } catch (error) {
            const err = error as Error;
            const durationMs = Date.now() - startTime;

            await reviewRepo.updateStatus(review.id, 'FAILED', {
                durationMs,
                errorMessage: err.message,
                completedAt: new Date(),
            });

            return {
                reviewId: review.id,
                status: 'failed',
                filesReviewed: 0,
                commentsPosted: 0,
                promptTokens: 0,
                completionTokens: 0,
                durationMs,
                summary: null,
                errorMessage: err.message,
            };
        }
    }

    private skipResult(reason: string): ReviewResult {
        return {
            reviewId: '',
            status: 'skipped',
            filesReviewed: 0,
            commentsPosted: 0,
            promptTokens: 0,
            completionTokens: 0,
            durationMs: 0,
            summary: reason,
            errorMessage: null,
        };
    }

    private async completeReview(
        reviewId: string,
        startTime: number,
        opts: { status: 'skipped' | 'completed'; summary: string },
    ): Promise<ReviewResult> {
        const durationMs = Date.now() - startTime;
        const dbStatus = opts.status === 'skipped' ? 'SKIPPED' as const : 'COMPLETED' as const;

        await reviewRepo.updateStatus(reviewId, dbStatus, {
            durationMs,
            summary: opts.summary,
            completedAt: new Date(),
        });

        return {
            reviewId,
            status: opts.status,
            filesReviewed: 0,
            commentsPosted: 0,
            promptTokens: 0,
            completionTokens: 0,
            durationMs,
            summary: opts.summary,
            errorMessage: null,
        };
    }
}

export const reviewService = new ReviewService();
