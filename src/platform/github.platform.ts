import { Octokit } from '@octokit/rest';
import { logger } from '../config/logger.js';
import {
    getInstallationOctokit,
    fetchPRMetadata as ghFetchPRMetadata,
    fetchPRDiff as ghFetchPRDiff,
    postIssueComment,
} from '../github/app.js';
import { postFullReview as ghPostFullReview } from '../github/review-poster.js';
import { applyReviewLabel } from '../github/label-manager.js';
import type {
    ReviewPlatform,
    PlatformContext,
    PlatformPRMetadata,
    PlatformReviewResult,
} from './platform.interface.js';
import type { LLMReviewResponse, ReviewIssue } from '../types/review.types.js';

// ═══════════════════════════════════════════════════════════════════════
// GitHub Platform Implementation
// ═══════════════════════════════════════════════════════════════════════
//
// Wraps the existing Octokit-based GitHub integration behind the
// ReviewPlatform interface. This is essentially a thin adapter around
// the functions we already have in src/github/*.ts.

export class GitHubPlatform implements ReviewPlatform {
    readonly name = 'GitHub';

    private octokitCache = new Map<number, Octokit>();

    /**
     * Get or create an authenticated Octokit for a GitHub App installation.
     */
    private async getOctokit(installationId: number): Promise<Octokit> {
        if (this.octokitCache.has(installationId)) {
            return this.octokitCache.get(installationId)!;
        }
        const octokit = await getInstallationOctokit(installationId);
        this.octokitCache.set(installationId, octokit);
        return octokit;
    }

    async fetchDiff(ctx: PlatformContext): Promise<string> {
        const octokit = await this.getOctokit(ctx.projectId);
        return ghFetchPRDiff(octokit, ctx.owner, ctx.repo, ctx.prNumber);
    }

    async fetchMetadata(ctx: PlatformContext): Promise<PlatformPRMetadata> {
        const octokit = await this.getOctokit(ctx.projectId);
        return ghFetchPRMetadata(octokit, ctx.owner, ctx.repo, ctx.prNumber);
    }

    async postSummaryComment(ctx: PlatformContext, markdown: string): Promise<number> {
        const octokit = await this.getOctokit(ctx.projectId);
        const { data } = await octokit.rest.issues.createComment({
            owner: ctx.owner,
            repo: ctx.repo,
            issue_number: ctx.prNumber,
            body: markdown,
        });
        return data.id;
    }

    async updateSummaryComment(ctx: PlatformContext, commentId: number, markdown: string): Promise<number> {
        const octokit = await this.getOctokit(ctx.projectId);
        try {
            await octokit.rest.issues.updateComment({
                owner: ctx.owner,
                repo: ctx.repo,
                comment_id: commentId,
                body: markdown,
            });
            return commentId;
        } catch (error) {
            const err = error as { status?: number };
            if (err.status === 404) {
                return this.postSummaryComment(ctx, markdown);
            }
            throw error;
        }
    }

    async postInlineComments(
        ctx: PlatformContext,
        reviewResult: LLMReviewResponse,
        _rawDiff: string,
        _ignorePatterns?: string[],
    ): Promise<number | null> {
        // Inline comments are handled inside postFullReview for GitHub
        // (via the atomic createReview API). This is a no-op when called separately.
        logger.debug('GitHub postInlineComments: handled via postFullReview');
        return null;
    }

    async applyLabels(ctx: PlatformContext, issues: ReviewIssue[], verdict: string): Promise<void> {
        const octokit = await this.getOctokit(ctx.projectId);
        await applyReviewLabel(octokit, ctx.owner, ctx.repo, ctx.prNumber, issues, verdict);
    }

    async postComment(ctx: PlatformContext, body: string): Promise<void> {
        const octokit = await this.getOctokit(ctx.projectId);
        await postIssueComment(octokit, ctx.owner, ctx.repo, ctx.prNumber, body);
    }

    async postFullReview(
        ctx: PlatformContext,
        reviewResult: LLMReviewResponse,
        metadata?: {
            filesReviewed: number;
            durationMs: number;
            promptTokens: number;
            completionTokens: number;
        },
        rawDiff?: string,
        ignorePatterns?: string[],
    ): Promise<PlatformReviewResult> {
        const octokit = await this.getOctokit(ctx.projectId);
        return ghPostFullReview(
            octokit, ctx.owner, ctx.repo, ctx.prNumber, ctx.headSha,
            reviewResult, metadata, rawDiff, ignorePatterns,
        );
    }
}
