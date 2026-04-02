import { z } from 'zod';

// ─── Issue Severity & Type ──────────────────────────────────────────────

export const IssueSeverityEnum = z.enum(['critical', 'high', 'medium', 'low']);
export type IssueSeverity = z.infer<typeof IssueSeverityEnum>;

export const IssueTypeEnum = z.enum(['bug', 'security', 'performance', 'logic', 'style', 'types']);
export type IssueType = z.infer<typeof IssueTypeEnum>;

export const VerdictEnum = z.enum(['approve', 'request_changes', 'comment']);
export type Verdict = z.infer<typeof VerdictEnum>;

// ─── LLM Review Response Schema ────────────────────────────────────────
//
// This is the EXACT shape Claude must return. Validated by Zod after
// every API call. If Claude returns anything else, the retry loop
// sends a repair prompt.

export const ReviewIssueSchema = z.object({
    severity: IssueSeverityEnum,
    type: IssueTypeEnum,
    filename: z.string().min(1),
    lineNumber: z.number().int().positive(),
    title: z.string().min(1).max(200),
    description: z.string().min(1),
    suggestion: z.string().min(1),
    codeSnippet: z.string().optional(),
    suggestionCode: z.string().optional(),
});

export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;

export const LLMReviewResponseSchema = z.object({
    summary: z.string().min(1),
    overallVerdict: VerdictEnum,
    issues: z.array(ReviewIssueSchema),
    positives: z.array(z.string()),
    questions: z.array(z.string()),
});

export type LLMReviewResponse = z.infer<typeof LLMReviewResponseSchema>;

// ─── Legacy compat: LLMComment (used by review.repo.ts addComments) ────

export const LLMCommentSchema = z.object({
    path: z.string(),
    line: z.number().int().positive(),
    side: z.enum(['LEFT', 'RIGHT']).default('RIGHT'),
    severity: z.enum(['critical', 'warning', 'suggestion', 'nitpick']),
    category: z.enum(['bug', 'security', 'performance', 'style', 'logic', 'readability', 'maintainability']),
    body: z.string().min(1),
});

export type LLMComment = z.infer<typeof LLMCommentSchema>;

// Map from new schema → legacy schema for posting to GitHub
export function issuesToComments(issues: ReviewIssue[]): LLMComment[] {
    const severityMap: Record<IssueSeverity, LLMComment['severity']> = {
        critical: 'critical',
        high: 'warning',
        medium: 'suggestion',
        low: 'nitpick',
    };
    const categoryMap: Record<IssueType, LLMComment['category']> = {
        bug: 'bug',
        security: 'security',
        performance: 'performance',
        logic: 'logic',
        style: 'style',
        types: 'style',
    };

    return issues.map((issue) => ({
        path: issue.filename,
        line: issue.lineNumber,
        side: 'RIGHT' as const,
        severity: severityMap[issue.severity],
        category: categoryMap[issue.type],
        body: formatIssueBody(issue),
    }));
}

function formatIssueBody(issue: ReviewIssue): string {
    const badge = {
        critical: '🔴 **Critical**',
        high: '🟠 **High**',
        medium: '🟡 **Medium**',
        low: '🔵 **Low**',
    }[issue.severity];

    const lines: string[] = [
        `${badge} — ${issue.title}`,
        '',
        issue.description,
        '',
        '**Suggestion:**',
        issue.suggestion,
    ];

    if (issue.codeSnippet) {
        lines.push('', '```suggestion', issue.codeSnippet, '```');
    }

    return lines.join('\n');
}

// ─── Internal Review Types ──────────────────────────────────────────────

export interface ReviewResult {
    reviewId: string;
    status: 'completed' | 'failed' | 'skipped';
    filesReviewed: number;
    commentsPosted: number;
    promptTokens: number;
    completionTokens: number;
    durationMs: number;
    summary: string | null;
    errorMessage: string | null;
}

// ─── Review Job Payload ─────────────────────────────────────────────────

export interface ReviewJobData {
    installationId: number;
    repoFullName: string;
    repoGithubId: number;
    prNumber: number;
    title: string;
    body: string | null;
    headSha: string;
    baseSha: string;
    sender: string;
    action: string;
    language: string | null;
    /** Which platform this review is for. Defaults to 'github'. */
    platform?: 'github' | 'gitlab';
}

// ─── Severity Badge Mapping ─────────────────────────────────────────────

export type SeverityLevel = LLMComment['severity'];

export const SEVERITY_BADGES: Record<SeverityLevel, string> = {
    critical: '🔴 **Critical**',
    warning: '🟡 **Warning**',
    suggestion: '🔵 **Suggestion**',
    nitpick: '⚪ **Nitpick**',
};
