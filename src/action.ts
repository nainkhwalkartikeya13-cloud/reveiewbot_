import * as core from '@actions/core';
import * as github from '@actions/github';
import Anthropic from '@anthropic-ai/sdk';

// ═══════════════════════════════════════════════════════════════════════
// AXD Review Bot — GitHub Action Entry Point
// ═══════════════════════════════════════════════════════════════════════
//
// Self-contained action that reviews PRs using Claude.
// No database, no Redis, no BullMQ — just diff → LLM → comments.
//
// Usage (3 lines):
//   - uses: KartikeyaNainkhwal/axd-review-bot@v1
//     with:
//       github-token: ${{ secrets.GITHUB_TOKEN }}
//       anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}

// ─── Types ──────────────────────────────────────────────────────────────

interface ReviewIssue {
    severity: 'critical' | 'high' | 'medium' | 'low';
    type: string;
    filename: string;
    lineNumber: number;
    title: string;
    description: string;
    suggestion: string;
    codeSnippet?: string;
    suggestionCode?: string;
}

interface LLMReviewResponse {
    summary: string;
    overallVerdict: 'approve' | 'request_changes' | 'comment';
    issues: ReviewIssue[];
    positives: string[];
    questions: string[];
}

// ─── Diff Position Mapping ──────────────────────────────────────────────

interface DiffPosition {
    position: number;
    lineType: 'add' | 'context' | 'remove';
    newLine: number;
}

function parseDiffPositions(rawDiff: string): Map<string, DiffPosition[]> {
    const map = new Map<string, DiffPosition[]>();
    const lines = rawDiff.split('\n');

    let currentFile: string | null = null;
    let positions: DiffPosition[] = [];
    let position = 0;
    let newLine = 0;

    for (const line of lines) {
        // File header
        const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
        if (fileMatch) {
            if (currentFile && positions.length > 0) {
                map.set(currentFile, positions);
            }
            currentFile = fileMatch[2];
            positions = [];
            position = 0;
            continue;
        }

        // Skip metadata lines
        if (line.startsWith('---') || line.startsWith('+++') ||
            line.startsWith('index ') || line.startsWith('old mode') ||
            line.startsWith('new mode') || line.startsWith('new file') ||
            line.startsWith('deleted file') || line.startsWith('similarity') ||
            line.startsWith('rename') || line.startsWith('Binary')) {
            continue;
        }

        // Hunk header
        const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (hunkMatch) {
            position++;
            newLine = parseInt(hunkMatch[1], 10);
            continue;
        }

        if (!currentFile) continue;
        if (line.startsWith('\\ No newline')) continue;

        position++;

        if (line.startsWith('+')) {
            positions.push({ position, lineType: 'add', newLine });
            newLine++;
        } else if (line.startsWith('-')) {
            positions.push({ position, lineType: 'remove', newLine: -1 });
        } else {
            positions.push({ position, lineType: 'context', newLine });
            newLine++;
        }
    }

    if (currentFile && positions.length > 0) {
        map.set(currentFile, positions);
    }

    return map;
}

function findDiffPosition(
    posMap: Map<string, DiffPosition[]>,
    filename: string,
    lineNumber: number,
): { position: number; isAdd: boolean } | null {
    const entries = posMap.get(filename);
    if (!entries) return null;

    // Exact match
    for (const e of entries) {
        if (e.newLine === lineNumber) {
            return { position: e.position, isAdd: e.lineType === 'add' };
        }
    }

    // Fuzzy match ±3 lines
    for (let delta = 1; delta <= 3; delta++) {
        for (const e of entries) {
            if (e.newLine === lineNumber - delta || e.newLine === lineNumber + delta) {
                return { position: e.position, isAdd: e.lineType === 'add' };
            }
        }
    }

    return null;
}

// ─── System Prompt ──────────────────────────────────────────────────────

function getSystemPrompt(customRules: string[]): string {
    const rulesBlock = customRules.length > 0
        ? `\n\nCustom rules for this repo:\n${customRules.map((r) => `- ${r}`).join('\n')}`
        : '';

    return `You are AXD, a senior software engineer performing a thorough code review. You are direct, precise, and focus only on issues that actually matter. You do not nitpick style unless it causes bugs.

Focus on (in this order):
1. Security vulnerabilities (SQL injection, XSS, auth bypass, exposed secrets)
2. Logic bugs and incorrect behavior
3. Performance problems (N+1 queries, memory leaks, blocking operations)
4. Error handling gaps
5. Type safety issues (TypeScript)
${rulesBlock}

Respond in this EXACT JSON format (no markdown, no code fences):
{
  "summary": "2-3 sentence summary of the PR changes and overall quality",
  "overallVerdict": "approve" | "request_changes" | "comment",
  "issues": [
    {
      "severity": "critical" | "high" | "medium" | "low",
      "type": "bug" | "security" | "performance" | "logic" | "style" | "types",
      "filename": "path/to/file.ts",
      "lineNumber": 42,
      "title": "Short descriptive title (max 100 chars)",
      "description": "What's wrong and why it matters",
      "suggestion": "How to fix it",
      "codeSnippet": "optional replacement code",
      "suggestionCode": "exact drop-in replacement for the line (for GitHub suggestion blocks)"
    }
  ],
  "positives": ["What the PR does well"],
  "questions": ["Questions for the author"]
}

Rules:
- Only report REAL issues. False positives destroy trust.
- If the code is clean, return an empty issues array and verdict "approve".
- "suggestionCode" must be the EXACT replacement for the target line — it will be inserted into a GitHub suggestion block.
- Every issue MUST have a filename and lineNumber pointing to a real line in the diff.`;
}

// ─── Comment Formatting ─────────────────────────────────────────────────

const SEVERITY_EMOJI: Record<string, string> = {
    critical: '🔴',
    high: '🟠',
    medium: '🟡',
    low: '🔵',
};

function formatInlineComment(issue: ReviewIssue, isAddLine: boolean): string {
    const lines: string[] = [];

    if (issue.suggestionCode && isAddLine) {
        lines.push('```suggestion');
        lines.push(issue.suggestionCode);
        lines.push('```');
        lines.push(`**${issue.title}** · \`${issue.severity}\``);
        lines.push('');
        lines.push(issue.description);
    } else {
        lines.push(`**${issue.title}** · \`${issue.severity}\``);
        lines.push('');
        lines.push(issue.description);
        lines.push('');
        lines.push(`💡 **Suggestion:** ${issue.suggestion}`);
        if (issue.codeSnippet) {
            lines.push('');
            lines.push('```');
            lines.push(issue.codeSnippet);
            lines.push('```');
        }
    }

    return lines.join('\n');
}

function generateSummaryMarkdown(
    result: LLMReviewResponse,
    commitSha: string,
    filesReviewed: number,
): string {
    const lines: string[] = [];
    const verdictMap: Record<string, string> = {
        approve: '✅ **Approved**',
        request_changes: '🔴 **Changes Requested**',
        comment: '💬 **Reviewed**',
    };

    lines.push('## 🤖 AXD Review Summary');
    lines.push('');
    lines.push(`> ${verdictMap[result.overallVerdict]} · Reviewed commit \`${commitSha.slice(0, 7)}\` · ${new Date().toUTCString()}`);
    lines.push('');

    if (result.summary) {
        lines.push(result.summary);
        lines.push('');
    }

    if (result.issues.length > 0) {
        lines.push('### 📊 Issues Found');
        lines.push('');
        lines.push('| Severity | Count |');
        lines.push('|----------|-------|');

        const counts: Record<string, number> = {};
        for (const issue of result.issues) {
            counts[issue.severity] = (counts[issue.severity] ?? 0) + 1;
        }

        for (const sev of ['critical', 'high', 'medium', 'low'] as const) {
            const count = counts[sev] ?? 0;
            if (count > 0) {
                lines.push(`| ${SEVERITY_EMOJI[sev]} ${sev.charAt(0).toUpperCase() + sev.slice(1)} | ${count} |`);
            }
        }
        lines.push('');

        const topIssues = result.issues
            .filter((i) => i.severity === 'critical' || i.severity === 'high')
            .slice(0, 5);

        if (topIssues.length > 0) {
            lines.push('### ⚠️ Key Concerns');
            lines.push('');
            for (const issue of topIssues) {
                lines.push(`- ${SEVERITY_EMOJI[issue.severity]} **${issue.title}** — \`${issue.filename}:${issue.lineNumber}\``);
            }
            lines.push('');
        }
    }

    if (result.positives.length > 0) {
        lines.push('<details>');
        lines.push('<summary>✅ What Looks Good</summary>');
        lines.push('');
        for (const pos of result.positives) {
            lines.push(`- ${pos}`);
        }
        lines.push('');
        lines.push('</details>');
        lines.push('');
    }

    lines.push('<details>');
    lines.push('<summary>📈 Review Stats</summary>');
    lines.push('');
    lines.push(`- **Files reviewed:** ${filesReviewed}`);
    lines.push(`- **Issues found:** ${result.issues.length}`);
    lines.push(`- **Powered by:** Claude`);
    lines.push('');
    lines.push('</details>');
    lines.push('');

    lines.push('---');
    lines.push('> 🤖 AXD Review Bot · [GitHub Action](https://github.com/KartikeyaNainkhwal/reviewbot)');

    return lines.join('\n');
}

// ─── Severity Filtering ────────────────────────────────────────────────

const SEVERITY_ORDER: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
};

function filterBySeverity(issues: ReviewIssue[], threshold: string): ReviewIssue[] {
    const thresholdLevel = SEVERITY_ORDER[threshold] ?? 2;
    return issues.filter((i) => (SEVERITY_ORDER[i.severity] ?? 3) <= thresholdLevel);
}

// ─── Skip Patterns ──────────────────────────────────────────────────────

const DEFAULT_SKIP_PATTERNS = [
    /package-lock\.json$/i,
    /yarn\.lock$/i,
    /pnpm-lock\.yaml$/i,
    /\.(png|jpg|jpeg|gif|ico|svg|webp)$/i,
    /\.(woff2?|ttf|eot|otf)$/i,
    /\.min\.(js|css)$/i,
    /dist\//i,
];

function shouldSkipFile(filename: string, ignoreGlobs: string[]): boolean {
    for (const pattern of DEFAULT_SKIP_PATTERNS) {
        if (pattern.test(filename)) return true;
    }
    for (const glob of ignoreGlobs) {
        const escaped = glob.trim()
            .replace(/\./g, '\\.')
            .replace(/\*\*/g, '___DOUBLESTAR___')
            .replace(/\*/g, '[^/]*')
            .replace(/___DOUBLESTAR___/g, '.*');
        if (new RegExp(escaped).test(filename)) return true;
    }
    return false;
}

// ═══════════════════════════════════════════════════════════════════════
// Main Action
// ═══════════════════════════════════════════════════════════════════════

async function run(): Promise<void> {
    try {
        // ── Read inputs ─────────────────────────────────────────────────
        const token = core.getInput('github-token', { required: true });
        const anthropicKey = core.getInput('anthropic-api-key', { required: true });
        const model = core.getInput('model') || 'claude-sonnet-4-20250514';
        const severityThreshold = core.getInput('severity-threshold') || 'medium';
        const ignorePathsRaw = core.getInput('ignore-paths') || '';
        const failOnCritical = core.getInput('fail-on-critical') !== 'false';
        const maxFiles = parseInt(core.getInput('max-files') || '30', 10);
        const customRulesRaw = core.getInput('custom-rules') || '';

        const ignorePatterns = ignorePathsRaw.split(',').map((s) => s.trim()).filter(Boolean);
        const customRules = customRulesRaw.split(',').map((s) => s.trim()).filter(Boolean);

        // ── Validate context ────────────────────────────────────────────
        const context = github.context;

        if (!context.payload.pull_request) {
            core.info('Not a pull request event, skipping.');
            return;
        }

        const pr = context.payload.pull_request;
        const pullNumber = pr.number;
        const headSha = pr.head.sha as string;
        const owner = context.repo.owner;
        const repo = context.repo.repo;

        core.info(`🤖 AXD reviewing PR #${pullNumber} (${headSha.slice(0, 7)})`);

        // ── Fetch the diff ──────────────────────────────────────────────
        const octokit = github.getOctokit(token);

        const { data: diffData } = await octokit.rest.pulls.get({
            owner,
            repo,
            pull_number: pullNumber,
            mediaType: { format: 'diff' },
        });
        const rawDiff = diffData as unknown as string;

        if (!rawDiff || rawDiff.trim().length === 0) {
            core.info('Empty diff, nothing to review.');
            return;
        }

        // ── Fetch changed files ─────────────────────────────────────────
        const { data: files } = await octokit.rest.pulls.listFiles({
            owner,
            repo,
            pull_number: pullNumber,
            per_page: 100,
        });

        const reviewableFiles = files
            .filter((f) => !shouldSkipFile(f.filename, ignorePatterns))
            .filter((f) => f.patch && f.patch.length > 0)
            .slice(0, maxFiles);

        if (reviewableFiles.length === 0) {
            core.info('No reviewable files (all filtered out).');
            return;
        }

        core.info(`📄 Reviewing ${reviewableFiles.length} files (${files.length} total changed)`);

        // ── Build the diff for the LLM ──────────────────────────────────
        const diffForLLM = reviewableFiles.map((f) => {
            return `=== FILE: ${f.filename} ===\n${f.patch}`;
        }).join('\n\n');

        // Truncate if too large (Claude has context limits)
        const MAX_DIFF_CHARS = 120_000;
        const truncatedDiff = diffForLLM.length > MAX_DIFF_CHARS
            ? diffForLLM.slice(0, MAX_DIFF_CHARS) + '\n\n[... diff truncated due to size ...]'
            : diffForLLM;

        // ── Call Claude ─────────────────────────────────────────────────
        core.info('🧠 Sending diff to Claude for review...');

        const anthropic = new Anthropic({ apiKey: anthropicKey });

        const prTitle = pr.title as string;
        const prBody = (pr.body as string) || 'No description provided.';

        const userPrompt = `Review this Pull Request:

**Title:** ${prTitle}
**Description:** ${prBody}
**Author:** ${pr.user?.login ?? 'unknown'}
**Base:** ${pr.base?.ref ?? 'main'} ← **Head:** ${pr.head?.ref ?? 'feature'}

---

${truncatedDiff}`;

        const message = await anthropic.messages.create({
            model,
            max_tokens: 4096,
            system: getSystemPrompt(customRules),
            messages: [{ role: 'user', content: userPrompt }],
        });

        const responseText = message.content
            .filter((block): block is Anthropic.TextBlock => block.type === 'text')
            .map((block) => block.text)
            .join('');

        // ── Parse LLM response ──────────────────────────────────────────
        let result: LLMReviewResponse;

        try {
            // Try to extract JSON from response (handle markdown fences)
            const jsonMatch = responseText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error('No JSON found in response');
            result = JSON.parse(jsonMatch[0]) as LLMReviewResponse;
        } catch (parseError) {
            core.warning(`Failed to parse LLM response: ${parseError}`);
            core.warning(`Raw response: ${responseText.slice(0, 500)}`);
            result = {
                summary: 'AXD was unable to parse the review. Please check the workflow logs.',
                overallVerdict: 'comment',
                issues: [],
                positives: [],
                questions: [],
            };
        }

        // Filter by severity threshold
        result.issues = filterBySeverity(result.issues, severityThreshold);

        const criticalCount = result.issues.filter((i) => i.severity === 'critical').length;
        const highCount = result.issues.filter((i) => i.severity === 'high').length;

        core.info(`📋 Review complete: ${result.overallVerdict} | ${result.issues.length} issues | ${criticalCount} critical`);

        // ── Post inline comments via PR Review ──────────────────────────
        const posMap = parseDiffPositions(rawDiff);
        const comments: Array<{
            path: string;
            position: number;
            body: string;
        }> = [];

        for (const issue of result.issues) {
            const pos = findDiffPosition(posMap, issue.filename, issue.lineNumber);
            if (pos) {
                comments.push({
                    path: issue.filename,
                    position: pos.position,
                    body: formatInlineComment(issue, pos.isAdd),
                });
            }
        }

        // Map verdict to GitHub review event
        const eventMap: Record<string, 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'> = {
            approve: 'APPROVE',
            request_changes: 'REQUEST_CHANGES',
            comment: 'COMMENT',
        };
        const reviewEvent = eventMap[result.overallVerdict] ?? 'COMMENT';

        // Post atomic review with inline comments
        if (comments.length > 0) {
            try {
                await octokit.rest.pulls.createReview({
                    owner,
                    repo,
                    pull_number: pullNumber,
                    commit_id: headSha,
                    event: reviewEvent,
                    body: generateSummaryMarkdown(result, headSha, reviewableFiles.length),
                    comments,
                });
                core.info(`✅ Posted review with ${comments.length} inline comments`);
            } catch (reviewError) {
                core.warning(`Failed to post inline review, falling back to comment: ${reviewError}`);
                // Fallback: just post summary as a comment
                await octokit.rest.issues.createComment({
                    owner,
                    repo,
                    issue_number: pullNumber,
                    body: generateSummaryMarkdown(result, headSha, reviewableFiles.length),
                });
            }
        } else {
            // No inline comments — post summary only
            await octokit.rest.pulls.createReview({
                owner,
                repo,
                pull_number: pullNumber,
                commit_id: headSha,
                event: reviewEvent,
                body: generateSummaryMarkdown(result, headSha, reviewableFiles.length),
            });
            core.info('✅ Posted review summary (no inline comments needed)');
        }

        // ── Set outputs ─────────────────────────────────────────────────
        core.setOutput('verdict', result.overallVerdict);
        core.setOutput('issue-count', result.issues.length.toString());
        core.setOutput('critical-count', criticalCount.toString());
        core.setOutput('high-count', highCount.toString());

        // ── Fail if critical issues found ───────────────────────────────
        if (failOnCritical && criticalCount > 0) {
            core.setFailed(
                `🔴 AXD found ${criticalCount} critical issue${criticalCount > 1 ? 's' : ''}. Review the PR comments above.`
            );
        }
    } catch (error) {
        const err = error as Error;
        core.setFailed(`AXD Action failed: ${err.message}`);
    }
}

run();
