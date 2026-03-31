import type {
    ParsedDiff,
    ChunkExtractionResult,
    PRReviewStats,
} from '../types/diff.types.js';

// ─── Complexity thresholds ──────────────────────────────────────────────

const COMPLEXITY_THRESHOLDS = {
    trivial: { maxFiles: 2, maxChanges: 20 },
    small: { maxFiles: 5, maxChanges: 100 },
    medium: { maxFiles: 15, maxChanges: 500 },
    large: { maxFiles: 30, maxChanges: 1500 },
    // anything above = very_large
} as const;

// ─── Risk pattern detection ─────────────────────────────────────────────

const RISK_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /\.env$/, label: '⚠️ Environment file changed' },
    { pattern: /auth/i, label: '🔐 Authentication logic modified' },
    { pattern: /password|secret|token|key/i, label: '🔑 Security-sensitive code changed' },
    { pattern: /migration/i, label: '🗄️ Database migration added' },
    { pattern: /Dockerfile|docker-compose/i, label: '🐳 Docker config changed' },
    { pattern: /\.github\/workflows/i, label: '🔧 CI/CD pipeline modified' },
    { pattern: /prisma.*schema/i, label: '📐 Database schema changed' },
    { pattern: /package\.json$/i, label: '📦 Dependencies modified' },
    { pattern: /middleware/i, label: '🛡️ Middleware changed' },
    { pattern: /crypt|hash|sign/i, label: '🔒 Cryptographic code modified' },
    { pattern: /sql|query/i, label: '🗃️ Database query modified' },
    { pattern: /payment|billing|stripe|paypal/i, label: '💳 Payment logic modified' },
    { pattern: /api.*route|router/i, label: '🌐 API routes changed' },
];

// ─── Stats Builder ──────────────────────────────────────────────────────

/**
 * Build a comprehensive stats summary for a PR review.
 */
export function buildReviewStats(
    parsedDiff: ParsedDiff,
    extraction: ChunkExtractionResult,
): PRReviewStats {
    // Language breakdown
    const languageBreakdown: Record<string, number> = {};
    for (const file of parsedDiff.files) {
        const lang = file.language || 'unknown';
        languageBreakdown[lang] = (languageBreakdown[lang] ?? 0) + 1;
    }

    // Risk areas
    const riskAreas: string[] = [];
    const seenRisks = new Set<string>();

    for (const file of parsedDiff.files) {
        for (const { pattern, label } of RISK_PATTERNS) {
            if (pattern.test(file.filename) && !seenRisks.has(label)) {
                riskAreas.push(label);
                seenRisks.add(label);
            }
        }
    }

    // Complexity estimate
    const totalChanges = parsedDiff.totalAdditions + parsedDiff.totalDeletions;
    const complexity = estimateComplexity(parsedDiff.totalFiles, totalChanges);

    return {
        filesAnalyzed: extraction.stats.reviewableFiles,
        filesSkipped: extraction.stats.skippedFiles,
        totalAdditions: parsedDiff.totalAdditions,
        totalDeletions: parsedDiff.totalDeletions,
        languageBreakdown,
        complexityEstimate: complexity,
        riskAreas,
        chunkCount: extraction.stats.totalChunks,
        estimatedReviewTokens: extraction.stats.estimatedTotalTokens,
    };
}

function estimateComplexity(
    fileCount: number,
    changeCount: number,
): PRReviewStats['complexityEstimate'] {
    if (fileCount <= COMPLEXITY_THRESHOLDS.trivial.maxFiles &&
        changeCount <= COMPLEXITY_THRESHOLDS.trivial.maxChanges) {
        return 'trivial';
    }
    if (fileCount <= COMPLEXITY_THRESHOLDS.small.maxFiles &&
        changeCount <= COMPLEXITY_THRESHOLDS.small.maxChanges) {
        return 'small';
    }
    if (fileCount <= COMPLEXITY_THRESHOLDS.medium.maxFiles &&
        changeCount <= COMPLEXITY_THRESHOLDS.medium.maxChanges) {
        return 'medium';
    }
    if (fileCount <= COMPLEXITY_THRESHOLDS.large.maxFiles &&
        changeCount <= COMPLEXITY_THRESHOLDS.large.maxChanges) {
        return 'large';
    }
    return 'very_large';
}

// ─── Summary Formatter ──────────────────────────────────────────────────

/**
 * Format a markdown summary comment for the PR.
 */
export function formatStatsSummary(stats: PRReviewStats): string {
    const lines: string[] = [];

    lines.push('## 🤖 AXD Review Summary\n');

    // Complexity badge
    const badges: Record<PRReviewStats['complexityEstimate'], string> = {
        trivial: '🟢 Trivial',
        small: '🟢 Small',
        medium: '🟡 Medium',
        large: '🟠 Large',
        very_large: '🔴 Very Large',
    };
    lines.push(`**Complexity:** ${badges[stats.complexityEstimate]}\n`);

    // File stats table
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Files analyzed | ${stats.filesAnalyzed} |`);
    lines.push(`| Files skipped | ${stats.filesSkipped} |`);
    lines.push(`| Lines added | +${stats.totalAdditions} |`);
    lines.push(`| Lines removed | -${stats.totalDeletions} |`);
    lines.push(`| Review chunks | ${stats.chunkCount} |`);
    lines.push('');

    // Language breakdown (top 5)
    const sortedLangs = Object.entries(stats.languageBreakdown)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5);

    if (sortedLangs.length > 0) {
        lines.push('**Languages:** ' +
            sortedLangs.map(([lang, count]) => `${lang} (${count})`).join(', '));
        lines.push('');
    }

    // Risk areas
    if (stats.riskAreas.length > 0) {
        lines.push('### Risk Areas\n');
        for (const risk of stats.riskAreas) {
            lines.push(`- ${risk}`);
        }
        lines.push('');
    }

    lines.push('---');
    lines.push(`<sub>Estimated review tokens: ~${(stats.estimatedReviewTokens / 1000).toFixed(1)}k</sub>`);

    return lines.join('\n');
}
