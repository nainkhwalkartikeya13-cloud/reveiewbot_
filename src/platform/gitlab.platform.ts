import axios, { AxiosInstance } from 'axios';
import { logger } from '../config/logger.js';
import { determineLabelFromVerdict } from '../github/label-manager.js';
import { generateSummaryMarkdown } from './gitlab.summary.js';
import type {
    ReviewPlatform,
    PlatformContext,
    PlatformPRMetadata,
    PlatformReviewResult,
} from './platform.interface.js';
import type { LLMReviewResponse, ReviewIssue } from '../types/review.types.js';

// ═══════════════════════════════════════════════════════════════════════
// GitLab Platform Implementation
// ═══════════════════════════════════════════════════════════════════════
//
// Implements ReviewPlatform using GitLab REST API v4 via Axios.
// Works with both gitlab.com and self-hosted GitLab instances.
//
// Key differences from GitHub:
//  • PR → Merge Request (MR)
//  • PR comment → MR Note
//  • Inline comment → MR Discussion with position
//  • GitHub App auth → Personal/Project Access Token
//  • No atomic review submission — notes are created individually

const BOT_MARKER = '<!-- axd-review-summary -->';

export class GitLabPlatform implements ReviewPlatform {
    readonly name = 'GitLab';
    private client: AxiosInstance;

    constructor(baseUrl: string, accessToken: string) {
        this.client = axios.create({
            baseURL: `${baseUrl.replace(/\/+$/, '')}/api/v4`,
            headers: {
                'PRIVATE-TOKEN': accessToken,
                'Content-Type': 'application/json',
            },
            timeout: 30000,
        });
    }

    // ─── Diff Fetching ──────────────────────────────────────────────────

    /**
     * Fetch MR changes and convert to unified diff format.
     *
     * GitLab returns diffs per file via /merge_requests/:iid/changes
     * We reconstruct a unified diff string so parseDiff() works unchanged.
     */
    async fetchDiff(ctx: PlatformContext): Promise<string> {
        const { data } = await this.client.get(
            `/projects/${ctx.projectId}/merge_requests/${ctx.prNumber}/changes`,
        );

        const changes = data.changes as Array<{
            old_path: string;
            new_path: string;
            diff: string;
            new_file: boolean;
            renamed_file: boolean;
            deleted_file: boolean;
        }>;

        // Reconstruct unified diff format from GitLab's per-file diffs
        const diffParts = changes.map((change) => {
            const header = `diff --git a/${change.old_path} b/${change.new_path}`;
            const oldFile = change.new_file ? '/dev/null' : `a/${change.old_path}`;
            const newFile = change.deleted_file ? '/dev/null' : `b/${change.new_path}`;
            return `${header}\n--- ${oldFile}\n+++ ${newFile}\n${change.diff}`;
        });

        return diffParts.join('\n');
    }

    // ─── MR Metadata ────────────────────────────────────────────────────

    async fetchMetadata(ctx: PlatformContext): Promise<PlatformPRMetadata> {
        const { data: mr } = await this.client.get(
            `/projects/${ctx.projectId}/merge_requests/${ctx.prNumber}`,
        );

        // Fetch diff stats separately for accurate counts
        let additions = 0;
        let deletions = 0;
        let changedFiles = 0;

        try {
            const { data: changes } = await this.client.get(
                `/projects/${ctx.projectId}/merge_requests/${ctx.prNumber}/changes`,
            );
            changedFiles = changes.changes?.length ?? 0;
            for (const change of changes.changes ?? []) {
                const diffLines = (change.diff as string).split('\n');
                additions += diffLines.filter((l: string) => l.startsWith('+')).length;
                deletions += diffLines.filter((l: string) => l.startsWith('-')).length;
            }
        } catch {
            // Use basic info if changes API fails
        }

        return {
            title: mr.title,
            body: mr.description ?? null,
            author: mr.author?.username ?? 'unknown',
            baseRef: mr.target_branch,
            headRef: mr.source_branch,
            baseSha: mr.diff_refs?.base_sha ?? '',
            headSha: mr.diff_refs?.head_sha ?? mr.sha ?? '',
            changedFiles,
            additions,
            deletions,
            draft: mr.draft ?? mr.work_in_progress ?? false,
        };
    }

    // ─── Summary Comment ────────────────────────────────────────────────

    /**
     * Post or update the summary note on the MR.
     * Uses the BOT_MARKER to find existing bot comments.
     */
    async postSummaryComment(ctx: PlatformContext, markdown: string): Promise<number> {
        const body = `${BOT_MARKER}\n${markdown}`;

        // Check for existing bot comment
        const existingId = await this.findBotNote(ctx);
        if (existingId) {
            return this.updateSummaryComment(ctx, existingId, markdown);
        }

        const { data } = await this.client.post(
            `/projects/${ctx.projectId}/merge_requests/${ctx.prNumber}/notes`,
            { body },
        );

        logger.info({ noteId: data.id, mrIid: ctx.prNumber }, 'GitLab summary note posted');
        return data.id;
    }

    async updateSummaryComment(ctx: PlatformContext, commentId: number, markdown: string): Promise<number> {
        const body = `${BOT_MARKER}\n🔄 **Updated** ${new Date().toISOString()}\n\n${markdown}`;

        try {
            await this.client.put(
                `/projects/${ctx.projectId}/merge_requests/${ctx.prNumber}/notes/${commentId}`,
                { body },
            );
            logger.info({ noteId: commentId }, 'GitLab summary note updated');
            return commentId;
        } catch (error) {
            const err = error as { response?: { status?: number } };
            if (err.response?.status === 404) {
                return this.postSummaryComment(ctx, markdown);
            }
            throw error;
        }
    }

    // ─── Inline Comments ────────────────────────────────────────────────

    /**
     * Post inline comments as MR discussions with position.
     *
     * GitLab uses "discussions" for threaded inline comments, where each
     * discussion has a `position` object specifying file paths, line numbers,
     * and the diff refs (base/head/start SHA).
     */
    async postInlineComments(
        ctx: PlatformContext,
        reviewResult: LLMReviewResponse,
        _rawDiff: string,
        _ignorePatterns?: string[],
    ): Promise<number | null> {
        const issues = reviewResult.issues;
        if (issues.length === 0) return null;

        // Get diff refs for position mapping
        const { data: mr } = await this.client.get(
            `/projects/${ctx.projectId}/merge_requests/${ctx.prNumber}`,
        );
        const diffRefs = mr.diff_refs ?? {};

        let postedCount = 0;

        for (const issue of issues.slice(0, 30)) {
            try {
                await this.client.post(
                    `/projects/${ctx.projectId}/merge_requests/${ctx.prNumber}/discussions`,
                    {
                        body: this.formatInlineNote(issue),
                        position: {
                            position_type: 'text',
                            base_sha: diffRefs.base_sha ?? ctx.baseSha,
                            head_sha: diffRefs.head_sha ?? ctx.headSha,
                            start_sha: diffRefs.start_sha ?? ctx.baseSha,
                            new_path: issue.filename,
                            old_path: issue.filename,
                            new_line: issue.lineNumber,
                        },
                    },
                );
                postedCount++;
            } catch (error) {
                logger.warn(
                    { err: error, file: issue.filename, line: issue.lineNumber },
                    'Failed to post GitLab inline discussion (non-fatal)',
                );
            }
        }

        logger.info(
            { postedCount, totalIssues: issues.length, mrIid: ctx.prNumber },
            'GitLab inline discussions posted',
        );
        return postedCount;
    }

    // ─── Labels ─────────────────────────────────────────────────────────

    /**
     * Apply AXD labels to the MR.
     *
     * GitLab labels are project-level. We create them if missing,
     * then update the MR's labels array.
     */
    async applyLabels(ctx: PlatformContext, issues: ReviewIssue[], verdict: string): Promise<void> {
        try {
            const labelName = determineLabelFromVerdict(issues, verdict);

            // Ensure label exists at project level
            await this.ensureGitLabLabel(ctx.projectId, labelName);

            // Get current MR labels
            const { data: mr } = await this.client.get(
                `/projects/${ctx.projectId}/merge_requests/${ctx.prNumber}`,
            );
            const currentLabels = (mr.labels ?? []) as string[];

            // Remove old AXD labels, add new one
            const filtered = currentLabels.filter((l: string) => !l.startsWith('axd:'));
            filtered.push(labelName);

            await this.client.put(
                `/projects/${ctx.projectId}/merge_requests/${ctx.prNumber}`,
                { labels: filtered.join(',') },
            );

            logger.info({ label: labelName, mrIid: ctx.prNumber }, 'GitLab MR label applied');
        } catch (error) {
            logger.warn({ err: error, mrIid: ctx.prNumber }, 'Failed to apply GitLab label (non-fatal)');
        }
    }

    // ─── Simple Comment ─────────────────────────────────────────────────

    async postComment(ctx: PlatformContext, body: string): Promise<void> {
        await this.client.post(
            `/projects/${ctx.projectId}/merge_requests/${ctx.prNumber}/notes`,
            { body },
        );
    }

    // ─── Full Review Orchestration ──────────────────────────────────────

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
        // Step 1: Delete old bot inline discussions
        await this.cleanupOldDiscussions(ctx);

        // Step 2: Post/update summary comment
        const summaryMarkdown = generateSummaryMarkdown(reviewResult, metadata, ctx.headSha);
        const summaryCommentId = await this.postSummaryComment(ctx, summaryMarkdown);

        // Step 3: Post inline discussions
        let reviewId: number | null = null;
        if (rawDiff) {
            reviewId = await this.postInlineComments(ctx, reviewResult, rawDiff, ignorePatterns);
        }

        return { reviewId, summaryCommentId };
    }

    // ═══════════════════════════════════════════════════════════════════
    // Private Helpers
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Format an inline note body for a review issue.
     */
    private formatInlineNote(issue: ReviewIssue): string {
        const severityMap: Record<string, string> = {
            critical: '🔴 Critical',
            high: '🟠 High',
            medium: '🟡 Medium',
            low: '🔵 Low',
        };
        const badge = severityMap[issue.severity] ?? issue.severity;

        const lines: string[] = [];
        lines.push(`**${badge}** — **${issue.title}**`);
        lines.push('');
        lines.push(issue.description);
        lines.push('');
        lines.push(`**💡 Suggestion:** ${issue.suggestion}`);

        if (issue.suggestionCode) {
            lines.push('');
            lines.push('```suggestion:-0+0');
            lines.push(issue.suggestionCode);
            lines.push('```');
        } else if (issue.codeSnippet) {
            lines.push('');
            lines.push('```');
            lines.push(issue.codeSnippet);
            lines.push('```');
        }

        return lines.join('\n');
    }

    /**
     * Find the bot's existing summary note on an MR.
     */
    private async findBotNote(ctx: PlatformContext): Promise<number | null> {
        try {
            const { data: notes } = await this.client.get(
                `/projects/${ctx.projectId}/merge_requests/${ctx.prNumber}/notes`,
                { params: { sort: 'desc', per_page: 50 } },
            );

            for (const note of notes) {
                if (typeof note.body === 'string' && note.body.includes(BOT_MARKER)) {
                    return note.id;
                }
            }
        } catch {
            // If we can't fetch notes, just create a new one
        }
        return null;
    }

    /**
     * Ensure a label exists at the GitLab project level.
     */
    private async ensureGitLabLabel(projectId: number, labelName: string): Promise<void> {
        const colorMap: Record<string, string> = {
            'axd: critical': '#FF0000',
            'axd: needs-work': '#FF6B00',
            'axd: reviewed': '#0075CA',
            'axd: approved': '#00B300',
            'axd: low-risk': '#E4E669',
        };

        try {
            await this.client.post(`/projects/${projectId}/labels`, {
                name: labelName,
                color: colorMap[labelName] ?? '#0075CA',
                description: `AXD Review Bot label`,
            });
        } catch (error) {
            const err = error as { response?: { status?: number } };
            // 409 = label already exists
            if (err.response?.status !== 409) {
                logger.debug({ labelName, error }, 'Label may already exist');
            }
        }
    }

    /**
     * Clean up old bot inline discussions (so re-reviews don't pile up).
     */
    private async cleanupOldDiscussions(ctx: PlatformContext): Promise<void> {
        try {
            const { data: discussions } = await this.client.get(
                `/projects/${ctx.projectId}/merge_requests/${ctx.prNumber}/discussions`,
                { params: { per_page: 100 } },
            );

            let deletedCount = 0;

            for (const discussion of discussions) {
                const firstNote = discussion.notes?.[0];
                if (
                    firstNote &&
                    typeof firstNote.body === 'string' &&
                    (firstNote.body.includes('🔴 Critical') ||
                        firstNote.body.includes('🟠 High') ||
                        firstNote.body.includes('🟡 Medium') ||
                        firstNote.body.includes('🔵 Low'))
                ) {
                    try {
                        await this.client.delete(
                            `/projects/${ctx.projectId}/merge_requests/${ctx.prNumber}/notes/${firstNote.id}`,
                        );
                        deletedCount++;
                    } catch {
                        // Note may have already been deleted
                    }
                }
            }

            if (deletedCount > 0) {
                logger.info({ deletedCount, mrIid: ctx.prNumber }, 'Cleaned up old GitLab discussions');
            }
        } catch (error) {
            logger.warn({ err: error }, 'Failed to cleanup old GitLab discussions');
        }
    }
}
