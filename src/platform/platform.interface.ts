import type { LLMReviewResponse, ReviewIssue } from '../types/review.types.js';

// ═══════════════════════════════════════════════════════════════════════
// Platform-agnostic Review Platform Interface
// ═══════════════════════════════════════════════════════════════════════
//
// Both GitHub and GitLab implement this interface, allowing the core
// review engine (diff parsing, LLM prompting, chunk extraction) to
// remain completely platform-agnostic.

/**
 * Common context passed to all platform operations.
 * Contains everything needed to identify a specific MR/PR.
 */
export interface PlatformContext {
    /** "github" or "gitlab" */
    platform: 'github' | 'gitlab';

    /** Owner/namespace (e.g., "octocat" or "my-group/sub-group") */
    owner: string;

    /** Repository name (e.g., "hello-world") */
    repo: string;

    /** PR number (GitHub) or MR IID (GitLab) */
    prNumber: number;

    /** HEAD commit SHA being reviewed */
    headSha: string;

    /** Base commit SHA */
    baseSha: string;

    /** Project ID (GitLab only, 0 for GitHub) */
    projectId: number;
}

/**
 * PR/MR metadata shared across platforms.
 */
export interface PlatformPRMetadata {
    title: string;
    body: string | null;
    author: string;
    baseRef: string;
    headRef: string;
    baseSha: string;
    headSha: string;
    changedFiles: number;
    additions: number;
    deletions: number;
    draft: boolean;
}

/**
 * Result of posting a review (summary comment + inline comments).
 */
export interface PlatformReviewResult {
    /** ID of the review (GitHub review ID, or null) */
    reviewId: number | null;

    /** ID of the summary comment */
    summaryCommentId: number;
}

/**
 * The platform abstraction interface.
 *
 * Each platform (GitHub, GitLab, Bitbucket, etc.) implements this
 * interface so the review engine can work identically regardless of
 * which code hosting platform is being used.
 */
export interface ReviewPlatform {
    /** Human-readable platform name */
    readonly name: string;

    /**
     * Fetch the unified diff for a PR/MR.
     * Returns raw unified diff string compatible with `parseDiff()`.
     */
    fetchDiff(ctx: PlatformContext): Promise<string>;

    /**
     * Fetch PR/MR metadata (title, author, branches, etc.)
     */
    fetchMetadata(ctx: PlatformContext): Promise<PlatformPRMetadata>;

    /**
     * Post a summary comment on the PR/MR.
     * If one already exists, update it in place.
     *
     * @returns The comment/note ID
     */
    postSummaryComment(
        ctx: PlatformContext,
        markdown: string,
    ): Promise<number>;

    /**
     * Update an existing summary comment.
     * Falls back to creating a new one if the old one was deleted.
     *
     * @returns The comment/note ID
     */
    updateSummaryComment(
        ctx: PlatformContext,
        commentId: number,
        markdown: string,
    ): Promise<number>;

    /**
     * Post inline comments on specific lines of the diff.
     *
     * @param rawDiff - The raw diff for position mapping
     * @param ignorePatterns - Glob patterns for files to skip
     */
    postInlineComments(
        ctx: PlatformContext,
        reviewResult: LLMReviewResponse,
        rawDiff: string,
        ignorePatterns?: string[],
    ): Promise<number | null>;

    /**
     * Apply verdict-based labels to the PR/MR.
     * Creates labels if they don't exist.
     */
    applyLabels(
        ctx: PlatformContext,
        issues: ReviewIssue[],
        verdict: string,
    ): Promise<void>;

    /**
     * Post a simple text comment (for errors, skip messages, etc.)
     */
    postComment(ctx: PlatformContext, body: string): Promise<void>;

    /**
     * Post the full review (dismiss old, cleanup, summary + inline).
     * This orchestrates the complete review lifecycle.
     */
    postFullReview(
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
    ): Promise<PlatformReviewResult>;
}
