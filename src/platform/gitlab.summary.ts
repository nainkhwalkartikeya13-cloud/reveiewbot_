import type { LLMReviewResponse, ReviewIssue } from '../types/review.types.js';

// ═══════════════════════════════════════════════════════════════════════
// GitLab Summary Markdown Generator
// ═══════════════════════════════════════════════════════════════════════
//
// Generates the same beautiful summary as GitHub but in a format
// optimized for GitLab's markdown renderer.

const SEVERITY_EMOJI: Record<string, string> = {
    critical: '🔴',
    high: '🟠',
    medium: '🟡',
    low: '🔵',
};

const VERDICT_BADGE: Record<string, string> = {
    approve: '✅ **Approved**',
    request_changes: '🔴 **Changes Requested**',
    comment: '💬 **Reviewed**',
};

/**
 * Generate the summary markdown for a GitLab MR note.
 */
export function generateSummaryMarkdown(
    reviewResult: LLMReviewResponse,
    metadata?: {
        filesReviewed: number;
        durationMs: number;
        promptTokens: number;
        completionTokens: number;
    },
    commitSha?: string,
): string {
    const lines: string[] = [];

    // Header
    const verdict = VERDICT_BADGE[reviewResult.overallVerdict] ?? '💬 **Reviewed**';
    const sha = commitSha ? `\`${commitSha.slice(0, 7)}\`` : '';
    const timestamp = new Date().toUTCString();

    lines.push('## 🤖 ReviewCode Summary');
    lines.push('');
    lines.push(`> ${verdict} · Reviewed commit ${sha} · ${timestamp}`);
    lines.push('');

    // Summary
    if (reviewResult.summary) {
        lines.push('### 📝 Summary');
        lines.push('');
        lines.push(reviewResult.summary);
        lines.push('');
    }

    // Issue breakdown
    if (reviewResult.issues.length > 0) {
        lines.push('### 📊 Issues Found');
        lines.push('');
        lines.push('| Severity | Count |');
        lines.push('|----------|-------|');

        const counts: Record<string, number> = {};
        for (const issue of reviewResult.issues) {
            counts[issue.severity] = (counts[issue.severity] ?? 0) + 1;
        }

        for (const sev of ['critical', 'high', 'medium', 'low'] as const) {
            const count = counts[sev] ?? 0;
            if (count > 0) {
                lines.push(`| ${SEVERITY_EMOJI[sev]} ${sev.charAt(0).toUpperCase() + sev.slice(1)} | ${count} |`);
            }
        }
        lines.push('');

        // Top concerns
        const topIssues = reviewResult.issues
            .filter((i) => i.severity === 'critical' || i.severity === 'high')
            .slice(0, 3);

        if (topIssues.length > 0) {
            lines.push('### ⚠️ Key Concerns');
            lines.push('');
            for (const issue of topIssues) {
                lines.push(`- ${SEVERITY_EMOJI[issue.severity]} **${issue.title}** — \`${issue.filename}:${issue.lineNumber}\``);
            }
            lines.push('');
        }
    }

    // Positives
    if (reviewResult.positives.length > 0) {
        lines.push('<details>');
        lines.push('<summary>✅ What Looks Good</summary>');
        lines.push('');
        for (const pos of reviewResult.positives) {
            lines.push(`- ${pos}`);
        }
        lines.push('');
        lines.push('</details>');
        lines.push('');
    }

    // Metadata
    if (metadata) {
        lines.push('<details>');
        lines.push('<summary>📈 Review Stats</summary>');
        lines.push('');
        lines.push(`- **Files reviewed:** ${metadata.filesReviewed}`);
        lines.push(`- **Duration:** ${(metadata.durationMs / 1000).toFixed(1)}s`);
        lines.push(`- **Tokens:** ${metadata.promptTokens.toLocaleString()} prompt + ${metadata.completionTokens.toLocaleString()} completion`);
        lines.push('');
        lines.push('</details>');
        lines.push('');
    }

    // Footer
    lines.push('---');
    lines.push('> 🤖 ReviewCode Bot · AI-powered code review');

    return lines.join('\n');
}
