import { Octokit } from '@octokit/rest';
import { logger } from '../config/logger.js';
import { reviewRepo } from '../db/repositories/review.repo.js';
import type { LLMReviewResponse, ReviewIssue, IssueSeverity, Verdict } from '../types/review.types.js';

// ─── Constants ──────────────────────────────────────────────────────────

const BOT_SIGNATURE = '\n\n---\n<sub>🤖 Reviewed by **ReviewCode** · AI-powered code review</sub>';
const BOT_COMMENT_MARKER = '<!-- reviewcode-summary -->';
const BOT_REVIEW_MARKER = 'ReviewCode Code Review';
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
    types: '🔷',
};

const VERDICT_BADGE: Record<Verdict, string> = {
    approve: '✅ **Approved**',
    request_changes: '🔴 **Changes Requested**',
    comment: '💬 **Reviewed**',
};

// ═══════════════════════════════════════════════════════════════════════
// 1. Post inline review comments (with diff position mapping)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Post a GitHub Pull Request Review with inline comments at exact diff positions.
 *
 * All comments are submitted as ONE atomic review (not individual comments),
 * so the PR author gets a single notification with all findings.
 *
 * Key complexity: GitHub requires `position` (the 1-based line offset in the
 * diff hunk), NOT the file line number. This function handles the mapping
 * via `parseDiffPositions()`, which builds a lookup table from the raw diff.
 *
 * @param rawDiff - The raw unified diff string from the GitHub API
 * @param ignorePatterns - Glob patterns from .reviewcodereview.yml to skip files
 * @returns The review ID, or null if no review was posted
 */
export async function postReviewComments(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullNumber: number,
    commitSha: string,
    reviewResult: LLMReviewResponse,
    rawDiff?: string,
    ignorePatterns?: string[],
): Promise<number | null> {
    const issues = reviewResult.issues;

    // Nothing to post
    if (issues.length === 0) {
        logger.debug({ pullNumber }, 'No inline comments to post');
        return null;
    }

    // Build the diff position map if raw diff is available
    const positionMap = rawDiff ? parseDiffPositions(rawDiff) : null;

    // Filter and map issues to inline comments
    const mappedComments: Array<{
        path: string;
        line: number;
        side: 'RIGHT';
        body: string;
        position?: number;
    }> = [];

    let skippedCount = 0;

    for (const issue of issues) {
        // Skip files in ignore_paths
        if (ignorePatterns && ignorePatterns.length > 0) {
            const { configService } = await import('../services/config.service.js');
            if (configService.shouldIgnoreFile(issue.filename, ignorePatterns)) {
                skippedCount++;
                continue;
            }
        }

        // Try to map to diff position
        if (positionMap) {
            const position = mapLineNumberToDiffPosition(
                positionMap, issue.filename, issue.lineNumber,
            );

            if (position === null) {
                // Line not in diff — this issue can't be posted inline
                logger.debug(
                    { file: issue.filename, line: issue.lineNumber },
                    'Issue line not found in diff, skipping inline comment',
                );
                skippedCount++;
                continue;
            }

            // Determine if this line is an addition (for suggestion syntax)
            const isAddLine = isAdditionLine(positionMap, issue.filename, issue.lineNumber);

            mappedComments.push({
                path: issue.filename,
                line: issue.lineNumber,
                side: 'RIGHT' as const,
                body: formatInlineComment(issue, isAddLine),
            });
        } else {
            // No raw diff available — use line number directly (may fail)
            mappedComments.push({
                path: issue.filename,
                line: issue.lineNumber,
                side: 'RIGHT' as const,
                body: formatInlineComment(issue, true),
            });
        }
    }

    if (mappedComments.length === 0) {
        logger.info({ skippedCount }, 'All issues were filtered or unmapped, no inline comments to post');
        return null;
    }

    // Respect GitHub's limit
    const comments = mappedComments.slice(0, MAX_INLINE_COMMENTS);
    const truncated = mappedComments.length > MAX_INLINE_COMMENTS;

    // Determine review event based on severity
    const hasCriticalOrHigh = issues.some(
        (i) => i.severity === 'critical' || i.severity === 'high',
    );
    const event = hasCriticalOrHigh ? 'REQUEST_CHANGES' : 'COMMENT';

    // Build review body
    let reviewBody = `## 🤖 ReviewCode Code Review\n\n`;
    reviewBody += `${reviewResult.summary}\n\n`;
    reviewBody += `**Found ${issues.length} issue${issues.length === 1 ? '' : 's'}** `;
    reviewBody += `(${countBySeverity(issues)})\n`;

    if (truncated) {
        reviewBody += `\n> ⚠️ Showing first ${MAX_INLINE_COMMENTS} of ${mappedComments.length} issues.\n`;
    }
    if (skippedCount > 0) {
        reviewBody += `\n> ℹ️ ${skippedCount} issue${skippedCount === 1 ? '' : 's'} skipped (not in diff or in ignored files).\n`;
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
                skippedCount,
                pullNumber,
            },
            'PR review posted with inline comments',
        );

        return data.id;
    } catch (error) {
        const err = error as { status?: number; message?: string };

        // If line/position mapping fails, retry without inline comments
        if (err.status === 422) {
            logger.warn(
                { pullNumber, error: err.message },
                'Inline comment position failed, falling back to non-inline review',
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
// Diff Position Mapping
// ═══════════════════════════════════════════════════════════════════════

/**
 * A single entry in the diff position lookup table.
 *
 * `position` is the 1-based offset within the entire file's diff output,
 * counting from the first @@ header line. This is what GitHub's API
 * requires for inline comments.
 */
interface DiffPositionEntry {
    position: number;       // 1-based position in the diff
    lineType: 'add' | 'context' | 'remove';
    newLineNumber: number;  // Line number in the new file (for add/context)
    oldLineNumber: number;  // Line number in the old file (for remove/context)
}

/**
 * Map from filename → array of DiffPositionEntry.
 */
type DiffPositionMap = Map<string, DiffPositionEntry[]>;

/**
 * Parse a raw unified diff string into a position lookup table.
 *
 * GitHub's inline comment API requires a `position` field, which is the
 * 1-based line offset within the diff for that file (starting after the
 * first `@@ ... @@` header).
 *
 * This function walks through the entire diff, tracking:
 *  - Which file we're in (from `diff --git a/... b/...` headers)
 *  - The current diff position counter (resets per file)
 *  - Old/new line number counters (from `@@ -old,count +new,count @@`)
 *  - Whether each line is add (+), remove (-), or context (space)
 *
 * The returned map lets us look up: given a filename and new-file line number,
 * what `position` value does GitHub need?
 */
export function parseDiffPositions(rawDiff: string): DiffPositionMap {
    const map: DiffPositionMap = new Map();
    const lines = rawDiff.split('\n');

    let currentFile: string | null = null;
    let entries: DiffPositionEntry[] = [];
    let position = 0;  // 1-based, resets per file
    let oldLine = 0;
    let newLine = 0;

    for (const line of lines) {
        // ── New file header ───────────────────────────────────────────
        // "diff --git a/src/foo.ts b/src/foo.ts"
        if (line.startsWith('diff --git ')) {
            // Save previous file's entries
            if (currentFile && entries.length > 0) {
                map.set(currentFile, entries);
            }

            // Extract filename from "b/path" portion
            const match = line.match(/diff --git a\/.+ b\/(.+)/);
            currentFile = match?.[1] ?? null;
            entries = [];
            position = 0;
            continue;
        }

        // Skip file metadata lines (index, ---, +++)
        if (
            line.startsWith('index ') ||
            line.startsWith('--- ') ||
            line.startsWith('+++ ') ||
            line.startsWith('old mode ') ||
            line.startsWith('new mode ') ||
            line.startsWith('new file mode ') ||
            line.startsWith('deleted file mode ') ||
            line.startsWith('similarity index ') ||
            line.startsWith('rename from ') ||
            line.startsWith('rename to ') ||
            line.startsWith('Binary files ')
        ) {
            continue;
        }

        // ── Hunk header ──────────────────────────────────────────────
        // "@@ -10,7 +10,9 @@ function foo()"
        const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
            oldLine = parseInt(hunkMatch[1], 10);
            newLine = parseInt(hunkMatch[2], 10);
            position++; // The @@ line itself counts as a position
            entries.push({
                position,
                lineType: 'context',
                newLineNumber: newLine,
                oldLineNumber: oldLine,
            });
            continue;
        }

        // Skip if we haven't seen a file header yet
        if (!currentFile) continue;

        // ── Diff content lines ────────────────────────────────────────
        position++;

        if (line.startsWith('+')) {
            // Addition: only in new file
            entries.push({
                position,
                lineType: 'add',
                newLineNumber: newLine,
                oldLineNumber: 0,
            });
            newLine++;
        } else if (line.startsWith('-')) {
            // Deletion: only in old file
            entries.push({
                position,
                lineType: 'remove',
                newLineNumber: 0,
                oldLineNumber: oldLine,
            });
            oldLine++;
        } else if (line.startsWith(' ') || line === '') {
            // Context line: same in both files
            entries.push({
                position,
                lineType: 'context',
                newLineNumber: newLine,
                oldLineNumber: oldLine,
            });
            oldLine++;
            newLine++;
        } else if (line.startsWith('\\')) {
            // "\ No newline at end of file" — not a real diff line
            position--; // Don't count this
        }
    }

    // Save last file
    if (currentFile && entries.length > 0) {
        map.set(currentFile, entries);
    }

    return map;
}

/**
 * Map a file line number to a diff position.
 *
 * Given a filename and line number in the NEW version of the file,
 * returns the diff position GitHub needs for inline comments.
 *
 * Returns null if the line is not in the diff (e.g., it's in an
 * unchanged part of the file that's not in any hunk).
 */
export function mapLineNumberToDiffPosition(
    positionMap: DiffPositionMap,
    filename: string,
    lineNumber: number,
): number | null {
    const entries = positionMap.get(filename);
    if (!entries) return null;

    // Find the entry where newLineNumber matches and it's an add or context line
    for (const entry of entries) {
        if (
            entry.newLineNumber === lineNumber &&
            (entry.lineType === 'add' || entry.lineType === 'context')
        ) {
            return entry.position;
        }
    }

    // Line not found in diff — try to find the closest add/context line
    // within 2 lines (the LLM sometimes reports slightly off line numbers)
    for (const offset of [1, -1, 2, -2]) {
        for (const entry of entries) {
            if (
                entry.newLineNumber === lineNumber + offset &&
                (entry.lineType === 'add' || entry.lineType === 'context')
            ) {
                logger.debug(
                    { filename, requested: lineNumber, found: entry.newLineNumber },
                    'Using fuzzy line match for inline comment',
                );
                return entry.position;
            }
        }
    }

    return null;
}

/**
 * Check if a specific line in the diff is an addition line (+).
 * Only addition lines support GitHub suggestion syntax.
 */
function isAdditionLine(
    positionMap: DiffPositionMap,
    filename: string,
    lineNumber: number,
): boolean {
    const entries = positionMap.get(filename);
    if (!entries) return false;

    for (const entry of entries) {
        if (entry.newLineNumber === lineNumber && entry.lineType === 'add') {
            return true;
        }
    }
    return false;
}

// ═══════════════════════════════════════════════════════════════════════
// 2. Smart Summary Comment Management (Upsert)
// ═══════════════════════════════════════════════════════════════════════

/**
 * The single entry point for posting/updating the PR summary comment.
 *
 * Orchestrates the full flow:
 *  1. Check PostgreSQL for an existing summary comment_id for this PR
 *  2. If found → update it in-place with a 🔄 Updated badge
 *  3. If not found (or deleted) → create a new comment and store the ID
 *
 * This is the ONLY function the worker/service should call for summaries.
 */
export async function upsertSummaryComment(
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
    const markdown = formatSummaryComment(reviewResult, metadata);

    // Step 1: Check DB for existing comment ID
    const dbCommentId = await getExistingCommentId(owner, repo, pullNumber);

    if (dbCommentId) {
        // Step 2a: Try to update in-place
        const updatedId = await updateSummaryComment(
            octokit, owner, repo, dbCommentId, markdown,
        );

        if (updatedId) {
            return updatedId;
        }

        // If update returned null, comment was deleted — fall through to create
        logger.info({ pullNumber, oldCommentId: dbCommentId }, 'Previous comment was deleted, creating new');
    } else {
        // Step 2b: No DB record — scan GitHub as fallback (handles manual DB wipes)
        const ghCommentId = await findExistingCommentOnGitHub(octokit, owner, repo, pullNumber);

        if (ghCommentId) {
            const updatedId = await updateSummaryComment(
                octokit, owner, repo, ghCommentId, markdown,
            );
            if (updatedId) return updatedId;
        }
    }

    // Step 3: Create brand new comment
    const newId = await createSummaryComment(octokit, owner, repo, pullNumber, markdown);
    return newId;
}

// ─── 2a. DB-first lookup ────────────────────────────────────────────────

/**
 * Query PostgreSQL for an existing summary comment_id for this PR.
 *
 * Looks at the most recent COMPLETED review for this (owner/repo, prNumber)
 * that has a non-null githubCommentId.
 *
 * @returns The GitHub comment ID if exists, null otherwise.
 */
export async function getExistingCommentId(
    owner: string,
    repo: string,
    pullNumber: number,
): Promise<number | null> {
    try {
        const repoFullName = `${owner}/${repo}`;
        const commentId = await reviewRepo.findLatestCommentId(repoFullName, pullNumber);
        if (commentId) {
            logger.debug({ pullNumber, commentId }, 'Found existing summary comment ID in DB');
        }
        return commentId;
    } catch (error) {
        logger.warn({ err: error, pullNumber }, 'Failed to query DB for existing comment');
        return null;
    }
}

// ─── 2b. GitHub API fallback scan ───────────────────────────────────────

/**
 * Scan GitHub PR comments to find an existing ReviewCode summary comment.
 * Uses the hidden HTML marker to identify our comments.
 * This is the fallback when the DB has no record (e.g., first run after migration).
 */
export async function findExistingCommentOnGitHub(
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

        if (botComment) {
            logger.debug({ commentId: botComment.id, pullNumber }, 'Found existing comment via GitHub API');
        }

        return botComment?.id ?? null;
    } catch (error) {
        logger.warn({ err: error, pullNumber }, 'Failed to search GitHub for existing comments');
        return null;
    }
}

// ─── 2c. Update existing comment with "Updated" badge ───────────────────

/**
 * Update an existing summary comment in-place.
 *
 * Prepends a "🔄 Updated" badge with the current timestamp so the PR author
 * knows the review has been refreshed.
 *
 * Handles 404 gracefully (comment was deleted by user) → returns null so the
 * caller can fall back to creating a new comment.
 *
 * @returns The comment ID if successfully updated, or null if the comment no longer exists.
 */
export async function updateSummaryComment(
    octokit: Octokit,
    owner: string,
    repo: string,
    commentId: number,
    markdown: string,
): Promise<number | null> {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const updatedMarkdown = markdown.replace(
        BOT_COMMENT_MARKER,
        `${BOT_COMMENT_MARKER}\n\n> 🔄 **Updated** at ${timestamp} (previous review was superseded)`,
    );

    try {
        const { data } = await octokit.rest.issues.updateComment({
            owner,
            repo,
            comment_id: commentId,
            body: updatedMarkdown,
        });

        logger.info({ commentId: data.id, pullNumber: 'N/A' }, 'Summary comment updated in-place');
        return data.id;
    } catch (error) {
        const err = error as { status?: number };

        if (err.status === 404) {
            // Comment was deleted by user — return null to signal fallback
            logger.warn({ commentId }, 'Comment was deleted (404), will create new');
            return null;
        }

        logger.error({ err: error, commentId }, 'Failed to update comment');
        throw error;
    }
}

// ─── 2d. Create a brand new summary comment ─────────────────────────────

/**
 * Create a brand new summary comment on the PR and log it.
 */
async function createSummaryComment(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullNumber: number,
    markdown: string,
): Promise<number> {
    const { data } = await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body: markdown,
    });

    logger.info({ commentId: data.id, pullNumber }, 'New summary comment created');
    return data.id;
}

// ═══════════════════════════════════════════════════════════════════════
// 3. Stale Review Cleanup
// ═══════════════════════════════════════════════════════════════════════

/**
 * Dismiss previous REQUEST_CHANGES reviews left by the bot so they
 * don't block merge after a new commit is pushed.
 */
export async function dismissPreviousReviews(
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

        const botReviews = reviews.filter(
            (r) =>
                r.state === 'CHANGES_REQUESTED' &&
                r.body?.includes(BOT_REVIEW_MARKER),
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

/**
 * Delete ALL previous inline review comments posted by the bot on a PR.
 *
 * When a developer pushes a new commit, old inline comments become stale
 * (they point to outdated line numbers). This function cleans them up
 * before the bot posts fresh inline comments on the latest diff.
 *
 * Only deletes comments that contain our bot marker text.
 */
export async function deleteStaleInlineReviews(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullNumber: number,
): Promise<number> {
    let deletedCount = 0;

    try {
        // List all review comments (inline comments on the diff)
        const reviewComments = await octokit.paginate(
            octokit.rest.pulls.listReviewComments,
            { owner, repo, pull_number: pullNumber, per_page: 100 },
        );

        // Find comments posted by our bot (look for severity badges)
        const botComments = reviewComments.filter(
            (c) => {
                const body = c.body ?? '';
                return (
                    body.includes('🔴 Critical') ||
                    body.includes('🟠 High') ||
                    body.includes('🟡 Medium') ||
                    body.includes('🔵 Low')
                ) && body.includes('**💡 Suggestion:**');
            },
        );

        if (botComments.length === 0) {
            logger.debug({ pullNumber }, 'No stale inline comments to delete');
            return 0;
        }

        logger.info(
            { pullNumber, count: botComments.length },
            'Deleting stale inline review comments',
        );

        // Delete each stale comment (GitHub API requires individual deletes)
        for (const comment of botComments) {
            try {
                await octokit.rest.pulls.deleteReviewComment({
                    owner,
                    repo,
                    comment_id: comment.id,
                });
                deletedCount++;
            } catch (error) {
                const err = error as { status?: number };
                if (err.status !== 404) {
                    logger.warn(
                        { commentId: comment.id, err: error },
                        'Failed to delete stale inline comment',
                    );
                }
                // 404 = already deleted, skip silently
            }
        }

        logger.info({ pullNumber, deletedCount }, 'Stale inline comments cleaned up');
    } catch (error) {
        logger.warn({ err: error, pullNumber }, 'Failed to list review comments for cleanup');
    }

    return deletedCount;
}

// ═══════════════════════════════════════════════════════════════════════
// Formatting functions
// ═══════════════════════════════════════════════════════════════════════

/**
 * Format a single inline comment for a review issue.
 */
/**
 * Format a single inline comment for a review issue.
 *
 * Uses GitHub's suggestion syntax when `suggestionCode` is present AND the
 * line is an addition line (+). GitHub only allows suggestion blocks on
 * lines that are part of the diff's added content.
 *
 * @param issue - The review issue
 * @param isOnAddLine - Whether the target line is a + (addition) line in the diff
 */
function formatInlineComment(issue: ReviewIssue, isOnAddLine: boolean = false): string {
    const badge = SEVERITY_BADGE[issue.severity];
    const typeEmoji = TYPE_EMOJI[issue.type];
    const lines: string[] = [];

    // If we have exact replacement code AND the line is an addition, use suggestion syntax
    if (issue.suggestionCode && isOnAddLine) {
        // GitHub suggestion syntax — shows a one-click "Apply suggestion" button
        lines.push('```suggestion');
        lines.push(issue.suggestionCode);
        lines.push('```');
        lines.push('');
        lines.push(`${badge} ${typeEmoji} **${issue.title}**`);
        lines.push('');
        lines.push(issue.description);
    } else {
        // Standard comment format
        lines.push(`${badge} ${typeEmoji} **${issue.title}**`);
        lines.push('');
        lines.push(issue.description);
        lines.push('');
        lines.push(`**💡 Suggestion:** ${issue.suggestion}`);

        // Fall back to codeSnippet as a suggestion block if on an add line
        if (issue.codeSnippet && isOnAddLine) {
            lines.push('');
            lines.push('```suggestion');
            lines.push(issue.codeSnippet);
            lines.push('```');
        } else if (issue.codeSnippet) {
            // Can't use suggestion syntax on non-add lines, show as code block
            lines.push('');
            lines.push('**Fixed code:**');
            lines.push('```');
            lines.push(issue.codeSnippet);
            lines.push('```');
        }
    }

    return lines.join('\n');
}

/**
 * Format the full PR summary comment.
 *
 * Produces a beautifully rendered GitHub Markdown summary including:
 *  - Verdict header with commit SHA and timestamp
 *  - Auto-generated PR description (2-3 lines)
 *  - Issue breakdown tables (severity + category)
 *  - Key concerns as bullet points
 *  - Collapsible positives and questions
 *  - All issues in a collapsible detailed table
 *  - Professional footer with stats and configure link
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
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

    // Hidden marker for finding/updating this comment later
    lines.push(BOT_COMMENT_MARKER);
    lines.push('');

    // ── Header ────────────────────────────────────────────────────────
    lines.push(`## 🤖 ReviewCode Summary`);
    lines.push('');

    if (metadata) {
        lines.push(`> Reviewed commit \`${metadata.commitSha.slice(0, 7)}\` · ${timestamp}`);
    } else {
        lines.push(`> ${timestamp}`);
    }
    lines.push('');

    // ── Verdict Banner ────────────────────────────────────────────────
    const verdictLine = VERDICT_BADGE[result.overallVerdict];
    const issueCount = result.issues.length;
    if (issueCount > 0) {
        const hasCritical = result.issues.some((i) => i.severity === 'critical');
        const hasHigh = result.issues.some((i) => i.severity === 'high');
        if (hasCritical || hasHigh) {
            lines.push(`> 🚨 ${verdictLine} — Found **${issueCount}** issue${issueCount !== 1 ? 's' : ''} requiring attention`);
        } else {
            lines.push(`> 💬 ${verdictLine} — Found **${issueCount}** minor issue${issueCount !== 1 ? 's' : ''}`);
        }
    } else {
        lines.push(`> ${verdictLine} — No issues found!`);
    }
    lines.push('');

    // ── Issue Stats Table (side-by-side severity + category) ─────────

    if (issueCount > 0) {
        const bySeverity = groupBy(result.issues, 'severity');
        const byType = groupBy(result.issues, 'type');

        lines.push('### 📊 Issues Found');
        lines.push('');

        // Severity breakdown table
        lines.push('| Severity | Count |');
        lines.push('|:---------|:-----:|');
        for (const sev of ['critical', 'high', 'medium', 'low'] as const) {
            const count = bySeverity[sev]?.length ?? 0;
            if (count > 0) {
                lines.push(`| ${SEVERITY_EMOJI[sev]} ${capitalize(sev)} | **${count}** |`);
            }
        }
        lines.push('');

        // Category breakdown table
        lines.push('| Category | Count |');
        lines.push('|:---------|:-----:|');
        for (const type of ['bug', 'security', 'performance', 'logic', 'style', 'types'] as const) {
            const count = byType[type]?.length ?? 0;
            if (count > 0) {
                lines.push(`| ${TYPE_EMOJI[type]} ${capitalize(type)} | **${count}** |`);
            }
        }
        lines.push('');
    }

    // ── What this PR does (auto-generated from LLM summary) ──────────

    lines.push('### 📝 What this PR does');
    lines.push('');
    lines.push(result.summary);
    lines.push('');

    // ── Key Concerns (top critical/high issues as bullet points) ─────

    if (issueCount > 0) {
        const topIssues = result.issues
            .filter((i) => i.severity === 'critical' || i.severity === 'high')
            .slice(0, 5);

        if (topIssues.length > 0) {
            lines.push('### ⚠️ Key Concerns');
            lines.push('');
            for (const issue of topIssues) {
                lines.push(
                    `- ${SEVERITY_EMOJI[issue.severity]} **${issue.title}** ` +
                    `in \`${issue.filename}:${issue.lineNumber}\``,
                );
                lines.push(`  > ${truncate(issue.description, 200)}`);
            }
            lines.push('');
        }

        // Medium/low issues summarized
        const mediumLow = result.issues.filter(
            (i) => i.severity === 'medium' || i.severity === 'low',
        );
        if (mediumLow.length > 0 && topIssues.length === 0) {
            lines.push('### ⚠️ Key Concerns');
            lines.push('');
            for (const issue of mediumLow.slice(0, 3)) {
                lines.push(
                    `- ${SEVERITY_EMOJI[issue.severity]} **${issue.title}** ` +
                    `in \`${issue.filename}:${issue.lineNumber}\``,
                );
                lines.push(`  > ${truncate(issue.description, 200)}`);
            }
            lines.push('');
        }

        // Full issues table (collapsible)
        lines.push('<details>');
        lines.push(`<summary><strong>📋 All ${issueCount} Issue${issueCount !== 1 ? 's' : ''}</strong></summary>`);
        lines.push('');
        lines.push('| # | Severity | Type | File | Issue |');
        lines.push('|:-:|:---------|:-----|:-----|:------|');
        result.issues.forEach((issue, idx) => {
            lines.push(
                `| ${idx + 1} ` +
                `| ${SEVERITY_EMOJI[issue.severity]} ${capitalize(issue.severity)} ` +
                `| ${TYPE_EMOJI[issue.type]} ${capitalize(issue.type)} ` +
                `| \`${issue.filename}:${issue.lineNumber}\` ` +
                `| ${issue.title} |`,
            );
        });
        lines.push('');
        lines.push('</details>');
        lines.push('');
    } else {
        lines.push('### ✅ No Issues Found');
        lines.push('');
        lines.push('The code looks clean! No bugs, security vulnerabilities, or performance problems detected.');
        lines.push('');
    }

    // ── What Looks Good ──────────────────────────────────────────────

    if (result.positives.length > 0) {
        lines.push('### ✅ What Looks Good');
        lines.push('');
        for (const positive of result.positives) {
            lines.push(`- 👏 ${positive}`);
        }
        lines.push('');
    }

    // ── Questions for the Author ─────────────────────────────────────

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

    // ── Footer ────────────────────────────────────────────────────────

    lines.push('---');
    lines.push('');

    if (metadata) {
        const durationSec = (metadata.durationMs / 1000).toFixed(1);
        const totalTokens = (metadata.promptTokens + metadata.completionTokens).toLocaleString();
        lines.push(
            `> 📝 Reviewed **${metadata.filesReviewed}** file${metadata.filesReviewed !== 1 ? 's' : ''} ` +
            `in **${durationSec}s** · **${totalTokens}** tokens · ` +
            `Commit: \`${metadata.commitSha.slice(0, 7)}\``,
        );
        lines.push('>');
    }

    lines.push(`> 🤖 Powered by **ReviewCode** · [Configure](/.reviewcodereview.yml) · ${timestamp}`);

    return lines.join('\n');
}

/**
 * Format a fallback review body (no inline comments).
 */
function formatFallbackReviewBody(result: LLMReviewResponse): string {
    const lines: string[] = [];

    lines.push(`## 🤖 ReviewCode Code Review\n`);
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
 * Post the complete review to GitHub.
 *
 * This is the SINGLE function the worker/service should call.
 * It orchestrates the full review lifecycle:
 *
 *  1. Dismiss any old REQUEST_CHANGES reviews from the bot
 *  2. Delete stale inline comments from previous reviews
 *  3. Upsert (create or update) the summary comment
 *  4. Post new inline review comments on the latest diff
 *
 * By cleaning up old comments first and upserting the summary, the PR
 * conversation stays clean with exactly ONE summary comment that gets
 * updated in-place on each push, plus fresh inline comments.
 *
 * @param rawDiff - Raw unified diff string for position mapping
 * @param ignorePatterns - Glob patterns to skip files from inline comments
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
    rawDiff?: string,
    ignorePatterns?: string[],
): Promise<{ reviewId: number | null; summaryCommentId: number }> {
    // Step 1: Dismiss old REQUEST_CHANGES reviews so they don't block merge
    await dismissPreviousReviews(octokit, owner, repo, pullNumber);

    // Step 2: Delete stale inline comments from previous bot reviews
    await deleteStaleInlineReviews(octokit, owner, repo, pullNumber);

    // Step 3: Upsert the summary comment (create new or update existing)
    // Posted FIRST so it appears at the top of the PR conversation.
    const summaryCommentId = await upsertSummaryComment(
        octokit, owner, repo, pullNumber, reviewResult,
        metadata ? { ...metadata, commitSha } : undefined,
    );

    // Step 4: Post fresh inline review comments on the latest diff
    const reviewId = await postReviewComments(
        octokit, owner, repo, pullNumber, commitSha, reviewResult,
        rawDiff, ignorePatterns,
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
