import { callGrok } from './client';
import { getSystemPrompt, buildReviewPrompt, buildRepairPrompt, type PRContext, type RepoReviewConfig } from './prompts';
import type { ReviewableChunk } from '../types/diff.types';
import type { LLMReviewResponse, ReviewIssue } from '../types/review.types';
import { issuesToComments } from '../types/review.types';
import type { LLMComment } from '../types/review.types';
import { logger } from '../config/logger';

// ─── Public types ───────────────────────────────────────────────────────

export interface ReviewOutput {
    /** All issues found across all chunks */
    issues: ReviewIssue[];
    /** Legacy comment format for posting to GitHub */
    comments: LLMComment[];
    /** Combined summary */
    summary: string;
    /** Overall verdict (worst across chunks wins) */
    overallVerdict: LLMReviewResponse['overallVerdict'];
    /** Positive observations */
    positives: string[];
    /** Questions for the author */
    questions: string[];
    /** Token usage */
    totalPromptTokens: number;
    totalCompletionTokens: number;
    /** Number of Grok calls made (including retries) */
    totalAttempts: number;
}

// ─── Verdict priority (worst wins when merging chunks) ──────────────────

const VERDICT_PRIORITY: Record<LLMReviewResponse['overallVerdict'], number> = {
    approve: 0,
    comment: 1,
    request_changes: 2,
};

// ─── Main entry point ───────────────────────────────────────────────────

/**
 * Review one or more diff chunks using Grok.
 *
 * For each chunk:
 *   1. Builds the full prompt (system + user)
 *   2. Calls Grok with retry/repair logic
 *   3. Collects and merges results
 *
 * Returns aggregated issues, comments, summary, and verdict.
 */
export async function reviewChunks(
    chunks: ReviewableChunk[],
    prContext: PRContext,
    repoConfig: RepoReviewConfig,
    fileContexts?: Map<string, string>,
): Promise<ReviewOutput> {
    const systemPrompt = getSystemPrompt();
    const allIssues: ReviewIssue[] = [];
    const allPositives: string[] = [];
    const allQuestions: string[] = [];
    const summaries: string[] = [];
    let worstVerdict: LLMReviewResponse['overallVerdict'] = 'approve';
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalAttempts = 0;

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];

        try {
            logger.info(
                {
                    chunkId: chunk.id,
                    chunkIndex: i + 1,
                    totalChunks: chunks.length,
                    fileCount: chunk.files.length,
                    priority: chunk.priority,
                    estimatedTokens: chunk.estimatedTokens,
                },
                'Reviewing chunk',
            );

            const userPrompt = buildReviewPrompt(chunk, prContext, repoConfig, fileContexts);

            const result = await callGrok(
                systemPrompt,
                userPrompt,
                buildRepairPrompt,
            );

            // Aggregate results
            allIssues.push(...result.response.issues);
            allPositives.push(...result.response.positives);
            allQuestions.push(...result.response.questions);
            summaries.push(result.response.summary);
            totalPromptTokens += result.promptTokens;
            totalCompletionTokens += result.completionTokens;
            totalAttempts += result.attempts;

            // Track worst verdict
            if (VERDICT_PRIORITY[result.response.overallVerdict] > VERDICT_PRIORITY[worstVerdict]) {
                worstVerdict = result.response.overallVerdict;
            }

            logger.info(
                {
                    chunkId: chunk.id,
                    issuesFound: result.response.issues.length,
                    verdict: result.response.overallVerdict,
                    promptTokens: result.promptTokens,
                    completionTokens: result.completionTokens,
                },
                'Chunk review completed',
            );
        } catch (error) {
            logger.error(
                {
                    err: error,
                    chunkId: chunk.id,
                    files: chunk.files.map((f) => f.filename),
                },
                'Failed to review chunk',
            );
            // Continue with other chunks — don't let one failure break everything
        }
    }

    // Merge summaries
    const summary = chunks.length === 1
        ? (summaries[0] ?? 'No reviewable content found.')
        : `Reviewed ${chunks.length} chunks:\n\n${summaries.map((s, i) => `**Chunk ${i + 1}:** ${s}`).join('\n\n')}`;

    // Deduplicate positives and questions
    const uniquePositives = [...new Set(allPositives)];
    const uniqueQuestions = [...new Set(allQuestions)];

    // Convert issues → legacy comment format for GitHub posting
    const comments = issuesToComments(allIssues);

    logger.info(
        {
            totalIssues: allIssues.length,
            totalComments: comments.length,
            overallVerdict: worstVerdict,
            totalPromptTokens,
            totalCompletionTokens,
            totalAttempts,
        },
        'All chunks reviewed',
    );

    return {
        issues: allIssues,
        comments,
        summary,
        overallVerdict: worstVerdict,
        positives: uniquePositives,
        questions: uniqueQuestions,
        totalPromptTokens,
        totalCompletionTokens,
        totalAttempts,
    };
}

// ─── Legacy compat ──────────────────────────────────────────────────────

/**
 * Legacy entry point used by review.service.ts.
 * Wraps reviewChunks for backward compatibility.
 */
export async function reviewFiles(
    files: { path: string; language: string; status: string; additions: number; deletions: number; hunks: Array<{ oldStart: number; oldLines: number; newStart: number; newLines: number; content: string; context: string }> }[],
    prTitle: string,
    prBody: string | null,
    language: string | null,
    customInstructions?: string,
): Promise<ReviewOutput> {
    // Convert legacy FileDiff[] to ReviewableChunk[]
    const chunkFiles = files.map((f) => ({
        filename: f.path,
        oldFilename: null,
        status: f.status as 'added' | 'modified' | 'deleted' | 'renamed',
        additions: f.additions,
        deletions: f.deletions,
        isBinary: false,
        hunks: f.hunks.map((h) => ({
            header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
            startLine: h.newStart,
            endLine: h.newStart + h.newLines - 1,
            oldStartLine: h.oldStart,
            oldEndLine: h.oldStart + h.oldLines - 1,
            lines: h.content.split('\n').map((line, idx) => ({
                // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
                type: (line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : 'context') as 'add' | 'remove' | 'context',
                lineNumber: h.newStart + idx,
                oldLineNumber: line.startsWith('+') ? null : h.oldStart + idx,
                newLineNumber: line.startsWith('-') ? null : h.newStart + idx,
                content: line.slice(1),
            })),
            context: h.context,
        })),
        language: f.language,
    }));

    const chunk: ReviewableChunk = {
        id: 'legacy-chunk-1',
        files: chunkFiles,
        priority: 'core',
        estimatedTokens: 0,
        reason: 'legacy reviewFiles() call',
    };

    const prContext: PRContext = {
        title: prTitle,
        description: prBody,
        author: 'unknown',
        baseBranch: 'main',
        headBranch: 'feature',
        language,
    };

    const repoConfig: RepoReviewConfig = {
        customInstructions,
    };

    return reviewChunks([chunk], prContext, repoConfig);
}
