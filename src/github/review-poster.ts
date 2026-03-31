import { Octokit } from '@octokit/rest';
import { logger } from '../config/logger';
import type { LLMReviewResponse, ReviewIssue, IssueSeverity, Verdict } from '../types/review.types';

// ─── Constants ──────────────────────────────────────────────────────────

const BOT_SIGNATURE = '\n\n---\n<sub>🤖 Reviewed by **AXD** · AI-powered code review</sub>';
const BOT_COMMENT_MARKER = '<!-- axd-review-summary -->';
const MAX_INLINE_COMMENTS = 50;  // GitHub API limit per review

// ─── Badge & emoji maps ─────────────────────────────────────────────────

const SEVERITY_BADGE: Record<IssueSeverity, string> = {
    critical: '🔴 Critical',
    high: '🟠 High',
    medium: '🟡 Medium',
    low: '🔵 Low',
};

const SEVERITY_EMOJI: Record<IssueSeverity, string> = {
    critical: '🔴',
    high: '🟠',
    medium: '🟡',
    low: '🔵',
};

const TYPE_EMOJI: Record<ReviewIssue['type'], string> = {
    bug: '🐛',
    security: '🔒',
    performance: '⚡',
    logic: '🧠',
    style: '🎨',
};

const VERDICT_BADGE: Record<Verdict, string> = {
    approve: '✅ **Approved**',
    request_changes: '🔴 **Changes Requested**',
    comment: '💬 **Reviewed**',
};

// ═══════════════════════════════════════════════════════════════════════
// 1. Post inline review comments
// ═══════════════════════════════════════════════════════════════════════

/**
 * Post a GitHub Pull Request Review with inline comments at exact line numbers.
 *
 * All comments are submitted as ONE atomic review (not individual comments),
 * so the PR author gets a single notification with all findings.
 *
 * Uses REQUEST_CHANGES if any critical/high issues exist, COMMENT otherwise.
 *
 * @returns The review ID, or null if no review was posted
 */
export async function postReviewComments(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullNumber: number,
    commitSha: string,
    reviewResult: LLMReviewResponse,
): Promise<number | null> {
    const issues = reviewResult.issues;

    // Nothing to post
    if (issues.length === 0) {
        logger.debug({ pullNumber }, 'No inline comments to post');
        return null;
    }

    // Respect GitHub's limit on inline comments per review
    const commentIssues = issues.slice(0, MAX_INLINE_COMMENTS);
    const truncated = issues.length > MAX_INLINE_COMMENTS;

    // Build inline comments
    const comments = commentIssues.map((issue) => ({
        path: issue.filename,
        line: issue.lineNumber,
        side: 'RIGHT' as const,
        body: formatInlineComment(issue),
    }));

    // Determine review event based on severity
    const hasCriticalOrHigh = issues.some(
        (i) => i.severity === 'critical' || i.severity === 'high',
    );
    const event = hasCriticalOrHigh ? 'REQUEST_CHANGES' : 'COMMENT';

    // Build review body (short summary at top of review)
    let reviewBody = `## 🤖 AXD Code Review\n\n`;
    reviewBody += `${reviewResult.summary}\n\n`;
    reviewBody += `**Found ${issues.length} issue${issues.length === 1 ? '' : 's'}** `;
    reviewBody += `(${countBySeverity(issues)})\n`;

    if (truncated) {
        reviewBody += `\n> ⚠️ Showing first ${MAX_INLINE_COMMENTS} of ${issues.length} issues.\n`;
    }

    try {
        const { data } = await octokit.rest.pulls.createReview({
            owner,
            repo,
            pull_number: pullNumber,
            commit_id: commitSha,
            event,
            body: reviewBody,
            comments,
        });

        logger.info(
            {
                reviewId: data.id,
                event,
                commentCount: comments.length,
                pullNumber,
            },
            'PR review posted',
        );

        return data.id;
    } catch (error) {
        const err = error as { status?: number; message?: string };

        // If line mapping fails, retry without inline comments
        if (err.status === 422 && err.message?.includes('pull_request_review_thread.line')) {
            logger.warn(
                { pullNumber, error: err.message },
                'Line mapping failed, falling back to non-inline review',
            );
            return postFallbackReview(octokit, owner, repo, pullNumber, commitSha, reviewResult);
        }

        logger.error({ err: error, pullNumber }, 'Failed to post review');
        throw error;
    }
}

/**
 * Fallback: post the review as a single comment body with issues listed
 * (no inline comments). Used when GitHub rejects line positions.
 */
async function postFallbackReview(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullNumber: number,
    commitSha: string,
    reviewResult: LLMReviewResponse,
): Promise<number> {
    const hasCriticalOrHigh = reviewResult.issues.some(
        (i) => i.severity === 'critical' || i.severity === 'high',
    );
    const event = hasCriticalOrHigh ? 'REQUEST_CHANGES' : 'COMMENT';

    const body = formatFallbackReviewBody(reviewResult);

    const { data } = await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        commit_id: commitSha,
        event,
        body,
    });

    logger.info({ reviewId: data.id, pullNumber }, 'Fallback review posted');
    return data.id;
}

// ═══════════════════════════════════════════════════════════════════════
// 2. Post PR summary comment
// ═══════════════════════════════════════════════════════════════════════

/**
 * Post a beautifully formatted summary comment on the PR.
 *
 * The comment includes:
 *  - Verdict badge
 *  - Summary text
 *  - Issue breakdown by severity and type
 *  - Key findings in collapsible sections
 *  - Positive observations
 *  - Questions for the author
 *  - Footer with timestamp
 *
 * If an existing AXD comment exists, it updates instead of creating a new one.
 */
export async function postPRSummaryComment(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullNumber: number,
    reviewResult: LLMReviewResponse,
    metadata?: {
        filesReviewed: number;
        durationMs: number;
        promptTokens: number;
        completionTokens: number;
        commitSha: string;
    },
): Promise<number> {
    const body = formatSummaryComment(reviewResult, metadata);

    // Try to update an existing comment first
    const existingCommentId = await findExistingComment(octokit, owner, repo, pullNumber);

    if (existingCommentId) {
        return updateExistingComment(octokit, owner, repo, existingCommentId, body);
    }

    // Create new comment
    const { data } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body,
    });

    logger.info({ commentId: data.id, pullNumber }, 'Summary comment posted');
    return data.id;
}

// ═══════════════════════════════════════════════════════════════════════
// 3. Update existing comment (on re-push)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Find an existing AXD summary comment on a PR.
 * Uses a hidden HTML marker to identify our comments.
 */
export async function findExistingComment(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullNumber: number,
): Promise<number | null> {
    try {
        const comments = await octokit.paginate(
            octokit.rest.issues.listComments,
            { owner, repo, issue_number: pullNumber, per_page: 100 },
        );

        const botComment = comments.find(
            (c) => c.body?.includes(BOT_COMMENT_MARKER),
        );

        return botComment?.id ?? null;
    } catch (error) {
        logger.warn({ err: error, pullNumber }, 'Failed to search for existing comments');
        return null;
    }
}

/**
 * Update an existing comment by ID with new content.
 */
export async function updateExistingComment(
    octokit: Octokit,
    owner: string,
    repo: string,
    commentId: number,
    body: string,
): Promise<number> {
    const { data } = await octokit.rest.issues.updateComment({
        owner,
        repo,
        comment_id: commentId,
        body,
    });

    logger.info({ commentId: data.id }, 'Summary comment updated');
    return data.id;
}

/**
 * Dismiss a previous review left by the bot (e.g., before posting a new one).
 */
export async function dismissPreviousReview(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullNumber: number,
): Promise<void> {
    try {
        const { data: reviews } = await octokit.rest.pulls.listReviews({
            owner,
            repo,
            pull_number: pullNumber,
            per_page: 100,
        });

        // Find reviews posted by our bot that are REQUEST_CHANGES
        const botReviews = reviews.filter(
            (r) =>
                r.state === 'CHANGES_REQUESTED' &&
                r.body?.includes('AXD Code Review'),
        );

        for (const review of botReviews) {
            try {
                await octokit.rest.pulls.dismissReview({
                    owner,
                    repo,
                    pull_number: pullNumber,
                    review_id: review.id,
                    message: '🤖 Superseded by new review on latest commit.',
                });
                logger.debug({ reviewId: review.id }, 'Previous review dismissed');
            } catch {
                // Non-critical — might fail if user already dismissed
            }
        }
    } catch (error) {
        logger.debug({ err: error }, 'Could not dismiss previous reviews');
    }
}

// ═══════════════════════════════════════════════════════════════════════
// Formatting functions
// ═══════════════════════════════════════════════════════════════════════

/**
 * Format a single inline comment for a review issue.
 */
function formatInlineComment(issue: ReviewIssue): string {
    const badge = SEVERITY_BADGE[issue.severity];
    const typeEmoji = TYPE_EMOJI[issue.type];
    const lines: string[] = [];

    lines.push(`${badge} ${typeEmoji} **${issue.title}**`);
    lines.push('');
    lines.push(issue.description);
    lines.push('');
    lines.push(`**💡 Suggestion:** ${issue.suggestion}`);

    if (issue.codeSnippet) {
        lines.push('');
        lines.push('```suggestion');
        lines.push(issue.codeSnippet);
        lines.push('```');
    }

    return lines.join('\n');
}

/**
 * Format the full PR summary comment.
 */
function formatSummaryComment(
    result: LLMReviewResponse,
    metadata?: {
        filesReviewed: number;
        durationMs: number;
        promptTokens: number;
        completionTokens: number;
        commitSha: string;
    },
): string {
    const lines: string[] = [];

    // Hidden marker for finding this comment later
    lines.push(BOT_COMMENT_MARKER);
    lines.push('');

    // Header with verdict
    lines.push(`# ${VERDICT_BADGE[result.overallVerdict]}`);
    lines.push('');

    // Summary text
    lines.push(`> ${result.summary}`);
    lines.push('');

    // ── Issue stats table ─────────────────────────────────────────────

    if (result.issues.length > 0) {
        const bySeverity = groupBy(result.issues, 'severity');
        const byType = groupBy(result.issues, 'type');

        lines.push('### 📊 Issue Breakdown');
        lines.push('');
        lines.push('| Severity | Count |');
        lines.push('|----------|-------|');
        for (const sev of ['critical', 'high', 'medium', 'low'] as const) {
            const count = bySeverity[sev]?.length ?? 0;
            if (count > 0) {
                lines.push(`| ${SEVERITY_EMOJI[sev]} ${capitalize(sev)} | ${count} |`);
            }
        }
        lines.push('');

        lines.push('| Category | Count |');
        lines.push('|----------|-------|');
        for (const type of ['bug', 'security', 'performance', 'logic', 'style'] as const) {
            const count = byType[type]?.length ?? 0;
            if (count > 0) {
                lines.push(`| ${TYPE_EMOJI[type]} ${capitalize(type)} | ${count} |`);
            }
        }
        lines.push('');

        // ── Key findings (collapsible for long lists) ─────────────────

        const criticalAndHigh = result.issues.filter(
            (i) => i.severity === 'critical' || i.severity === 'high',
        );

        if (criticalAndHigh.length > 0) {
            lines.push('### 🚨 Key Findings');
            lines.push('');
            for (const issue of criticalAndHigh) {
                lines.push(
                    `- ${SEVERITY_EMOJI[issue.severity]} **${issue.title}** — ` +
                    `\`${issue.filename}:${issue.lineNumber}\``,
                );
                lines.push(`  ${truncate(issue.description, 150)}`);
            }
            lines.push('');
        }

        // All issues (collapsible)
        if (result.issues.length > 3) {
            lines.push('<details>');
            lines.push(`<summary><strong>📋 All ${result.issues.length} Issues</strong></summary>`);
            lines.push('');
            lines.push('| # | Severity | Type | File | Issue |');
            lines.push('|---|----------|------|------|-------|');
            result.issues.forEach((issue, idx) => {
                lines.push(
                    `| ${idx + 1} | ${SEVERITY_EMOJI[issue.severity]} ${capitalize(issue.severity)} ` +
                    `| ${TYPE_EMOJI[issue.type]} ${capitalize(issue.type)} ` +
                    `| \`${issue.filename}:${issue.lineNumber}\` ` +
                    `| ${issue.title} |`,
                );
            });
            lines.push('');
            lines.push('</details>');
            lines.push('');
        }
    } else {
        lines.push('### ✅ No Issues Found');
        lines.push('');
        lines.push('The code looks clean! No bugs, security issues, or performance problems detected.');
        lines.push('');
    }

    // ── Positives ─────────────────────────────────────────────────────

    if (result.positives.length > 0) {
        lines.push('<details>');
        lines.push('<summary><strong>👏 What\'s Done Well</strong></summary>');
        lines.push('');
        for (const positive of result.positives) {
            lines.push(`- ✅ ${positive}`);
        }
        lines.push('');
        lines.push('</details>');
        lines.push('');
    }

    // ── Questions ─────────────────────────────────────────────────────

    if (result.questions.length > 0) {
        lines.push('<details>');
        lines.push('<summary><strong>❓ Questions for the Author</strong></summary>');
        lines.push('');
        for (const question of result.questions) {
            lines.push(`- ${question}`);
        }
        lines.push('');
        lines.push('</details>');
        lines.push('');
    }

    // ── Metadata footer ──────────────────────────────────────────────

    lines.push('---');

    if (metadata) {
        const durationSec = (metadata.durationMs / 1000).toFixed(1);
        const totalTokens = metadata.promptTokens + metadata.completionTokens;
        lines.push(
            `<sub>📝 Reviewed **${metadata.filesReviewed}** files in **${durationSec}s** ` +
            `· ${totalTokens.toLocaleString()} tokens ` +
            `· Commit: \`${metadata.commitSha.slice(0, 7)}\`</sub>`,
        );
    }

    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    lines.push(`<sub>🤖 Powered by **AXD** · ${timestamp}</sub>`);

    return lines.join('\n');
}

/**
 * Format a fallback review body (no inline comments).
 */
function formatFallbackReviewBody(result: LLMReviewResponse): string {
    const lines: string[] = [];

    lines.push(`## 🤖 AXD Code Review\n`);
    lines.push(`> ⚠️ *Inline comments could not be placed on exact diff lines. Listing all issues below.*\n`);
    lines.push(`${result.summary}\n`);

    for (const issue of result.issues) {
        lines.push(
            `### ${SEVERITY_BADGE[issue.severity]} ${TYPE_EMOJI[issue.type]} ${issue.title}\n` +
            `📁 \`${issue.filename}:${issue.lineNumber}\`\n\n` +
            `${issue.description}\n\n` +
            `**💡 Suggestion:** ${issue.suggestion}\n`,
        );

        if (issue.codeSnippet) {
            lines.push('```suggestion\n' + issue.codeSnippet + '\n```\n');
        }
    }

    lines.push(BOT_SIGNATURE);
    return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════════════
// Orchestrator (called by the worker)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Post the complete review to GitHub:
 *  1. Dismiss any old REQUEST_CHANGES reviews from the bot
 *  2. Post inline review comments as an atomic PR review
 *  3. Post (or update) the summary comment with stats and findings
 *
 * This is the single function the worker should call.
 */
export async function postFullReview(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullNumber: number,
    commitSha: string,
    reviewResult: LLMReviewResponse,
    metadata?: {
        filesReviewed: number;
        durationMs: number;
        promptTokens: number;
        completionTokens: number;
    },
): Promise<{ reviewId: number | null; summaryCommentId: number }> {
    // Step 1: Dismiss old bot reviews so they don't block merge
    await dismissPreviousReview(octokit, owner, repo, pullNumber);

    // Step 2: Post inline review (if there are issues)
    const reviewId = await postReviewComments(
        octokit, owner, repo, pullNumber, commitSha, reviewResult,
    );

    // Step 3: Post or update summary comment
    const summaryCommentId = await postPRSummaryComment(
        octokit, owner, repo, pullNumber, reviewResult,
        metadata ? { ...metadata, commitSha } : undefined,
    );

    return { reviewId, summaryCommentId };
}

// ═══════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════

function countBySeverity(issues: ReviewIssue[]): string {
    const counts: string[] = [];
    const grouped = groupBy(issues, 'severity');

    for (const sev of ['critical', 'high', 'medium', 'low'] as const) {
        const count = grouped[sev]?.length ?? 0;
        if (count > 0) {
            counts.push(`${SEVERITY_EMOJI[sev]} ${count} ${sev}`);
        }
    }

    return counts.join(' · ');
}

function groupBy<T extends Record<string, unknown>, K extends keyof T>(
    items: T[],
    key: K,
): Record<string, T[]> {
    const groups: Record<string, T[]> = {};
    for (const item of items) {
        const k = String(item[key]);
        (groups[k] ??= []).push(item);
    }
    return groups;
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

function truncate(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, max - 3) + '...';
}
