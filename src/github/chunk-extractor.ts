import { logger } from '../config/logger';
import type {
    DiffFile,
    ParsedDiff,
    FilePriority,
    ReviewableChunk,
    ChunkExtractionResult,
} from '../types/diff.types';

// ─── Constants ──────────────────────────────────────────────────────────

/** Approximate chars per token for code (conservative — OpenAI/Claude average ~3.5) */
const CHARS_PER_TOKEN = 3.5;

/** Max tokens per review chunk (leave room for system prompt + response) */
const MAX_CHUNK_TOKENS = 80_000;

/** Max lines to include in a single chunk (safety bound) */
// const MAX_CHUNK_LINES = 3000;

// ─── Skip patterns ─────────────────────────────────────────────────────

const SKIP_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    // Lock files
    { pattern: /package-lock\.json$/i, reason: 'lock file' },
    { pattern: /yarn\.lock$/i, reason: 'lock file' },
    { pattern: /pnpm-lock\.yaml$/i, reason: 'lock file' },
    { pattern: /Gemfile\.lock$/i, reason: 'lock file' },
    { pattern: /Cargo\.lock$/i, reason: 'lock file' },
    { pattern: /poetry\.lock$/i, reason: 'lock file' },
    { pattern: /composer\.lock$/i, reason: 'lock file' },
    { pattern: /go\.sum$/i, reason: 'lock file' },
    { pattern: /Pipfile\.lock$/i, reason: 'lock file' },
    { pattern: /flake\.lock$/i, reason: 'lock file' },

    // Generated files
    { pattern: /\.min\.(js|css)$/i, reason: 'minified file' },
    { pattern: /\.bundle\.(js|css)$/i, reason: 'bundled file' },
    { pattern: /\.generated\./i, reason: 'generated file' },
    { pattern: /\.d\.ts$/i, reason: 'type declaration (generated)' },
    { pattern: /dist\//i, reason: 'build output' },
    { pattern: /build\//i, reason: 'build output' },
    { pattern: /\.map$/i, reason: 'source map' },
    { pattern: /\.snap$/i, reason: 'snapshot file' },

    // Env examples
    { pattern: /\.env\.example$/i, reason: 'env example' },
    { pattern: /\.env\.sample$/i, reason: 'env example' },
    { pattern: /\.env\.template$/i, reason: 'env example' },

    // Assets & binaries
    { pattern: /\.(png|jpg|jpeg|gif|ico|svg|webp|bmp|tiff)$/i, reason: 'image file' },
    { pattern: /\.(woff2?|ttf|eot|otf)$/i, reason: 'font file' },
    { pattern: /\.(mp3|mp4|wav|avi|mov|webm)$/i, reason: 'media file' },
    { pattern: /\.(zip|tar|gz|rar|7z)$/i, reason: 'archive' },
    { pattern: /\.(pdf|doc|docx|xls|xlsx)$/i, reason: 'document' },
    { pattern: /\.(wasm|so|dylib|dll|exe)$/i, reason: 'binary' },

    // IDE / config noise
    { pattern: /\.idea\//i, reason: 'IDE config' },
    { pattern: /\.vscode\//i, reason: 'IDE config' },
    { pattern: /\.DS_Store$/i, reason: 'OS metadata' },
    { pattern: /thumbs\.db$/i, reason: 'OS metadata' },
];

// ─── Priority classification ────────────────────────────────────────────

const PRIORITY_RULES: Array<{ pattern: RegExp; priority: FilePriority }> = [
    // 🔴 Security-sensitive files (highest priority)
    { pattern: /auth/i, priority: 'security' },
    { pattern: /login/i, priority: 'security' },
    { pattern: /session/i, priority: 'security' },
    { pattern: /password/i, priority: 'security' },
    { pattern: /token/i, priority: 'security' },
    { pattern: /secret/i, priority: 'security' },
    { pattern: /crypt/i, priority: 'security' },
    { pattern: /permission/i, priority: 'security' },
    { pattern: /rbac/i, priority: 'security' },
    { pattern: /acl/i, priority: 'security' },
    { pattern: /oauth/i, priority: 'security' },
    { pattern: /jwt/i, priority: 'security' },
    { pattern: /middleware.*auth/i, priority: 'security' },
    { pattern: /sanitiz/i, priority: 'security' },
    { pattern: /validat/i, priority: 'security' },
    { pattern: /\.env$/, priority: 'security' },

    // 🟡 Core logic
    { pattern: /src\/.*\.(ts|js|py|go|rs|java|rb|cs)$/i, priority: 'core' },
    { pattern: /lib\/.*\.(ts|js|py|go|rs|java|rb|cs)$/i, priority: 'core' },
    { pattern: /app\/.*\.(ts|js|py|go|rs|java|rb|cs)$/i, priority: 'core' },
    { pattern: /api\/.*\.(ts|js|py|go|rs|java|rb|cs)$/i, priority: 'core' },
    { pattern: /server\.(ts|js)$/i, priority: 'core' },
    { pattern: /index\.(ts|js)$/i, priority: 'core' },
    { pattern: /\.prisma$/i, priority: 'core' },
    { pattern: /migration/i, priority: 'core' },

    // 🔵 Tests
    { pattern: /\.test\./i, priority: 'test' },
    { pattern: /\.spec\./i, priority: 'test' },
    { pattern: /\/__tests__\//i, priority: 'test' },
    { pattern: /\/tests?\//i, priority: 'test' },
    { pattern: /\.stories\./i, priority: 'test' },
    { pattern: /cypress\//i, priority: 'test' },
    { pattern: /e2e\//i, priority: 'test' },

    // ⚪ Config
    { pattern: /\.(json|ya?ml|toml|ini|cfg)$/i, priority: 'config' },
    { pattern: /Dockerfile/i, priority: 'config' },
    { pattern: /docker-compose/i, priority: 'config' },
    { pattern: /\.github\//i, priority: 'config' },
    { pattern: /\.(eslint|prettier|babel|jest)/i, priority: 'config' },
    { pattern: /tsconfig/i, priority: 'config' },
    { pattern: /webpack|vite|rollup|esbuild/i, priority: 'config' },

    // 📝 Docs (lowest among reviewable)
    { pattern: /\.(md|mdx|txt|rst)$/i, priority: 'docs' },
    { pattern: /README/i, priority: 'docs' },
    { pattern: /CONTRIBUTING/i, priority: 'docs' },
    { pattern: /CHANGELOG/i, priority: 'docs' },
    { pattern: /docs?\//i, priority: 'docs' },
];

const PRIORITY_ORDER: Record<FilePriority, number> = {
    security: 0,
    core: 1,
    test: 2,
    config: 3,
    docs: 4,
    generated: 5,
};

// ─── Core logic ─────────────────────────────────────────────────────────

/**
 * Extract reviewable chunks from a parsed diff.
 *
 * Steps:
 *  1. Filter out lock files, generated files, binaries, env examples
 *  2. Classify each file by priority (security > core > test > config > docs)
 *  3. Group related files (same directory / import chain)
 *  4. Split into chunks that fit within MAX_CHUNK_TOKENS
 *  5. Sort chunks by priority
 */
export function extractReviewableChunks(
    parsedDiff: ParsedDiff,
    maxTokensPerChunk: number = MAX_CHUNK_TOKENS,
): ChunkExtractionResult {
    const skipped: Array<{ filename: string; reason: string }> = [];
    const reviewable: Array<{ file: DiffFile; priority: FilePriority }> = [];

    // ── Step 1: Filter ────────────────────────────────────────────────

    for (const file of parsedDiff.files) {
        // Skip binary files
        if (file.isBinary) {
            skipped.push({ filename: file.filename, reason: 'binary file' });
            continue;
        }

        // Skip by pattern
        const skipRule = SKIP_PATTERNS.find((r) => r.pattern.test(file.filename));
        if (skipRule) {
            skipped.push({ filename: file.filename, reason: skipRule.reason });
            continue;
        }

        // Skip empty diffs (e.g., permission-only changes)
        if (file.hunks.length === 0 && file.additions === 0 && file.deletions === 0) {
            skipped.push({ filename: file.filename, reason: 'no content changes' });
            continue;
        }

        // ── Step 2: Classify ──────────────────────────────────────────

        const priority = classifyFile(file.filename);
        reviewable.push({ file, priority });
    }

    // ── Step 3: Group by directory ────────────────────────────────────

    const groups = groupByDirectory(reviewable);

    // ── Step 4: Build chunks within token limits ──────────────────────

    const chunks = buildChunks(groups, maxTokensPerChunk);

    // ── Step 5: Sort by priority ──────────────────────────────────────

    chunks.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

    // Assign IDs
    chunks.forEach((chunk, i) => {
        chunk.id = `chunk-${i + 1}`;
    });

    const estimatedTotalTokens = chunks.reduce((sum, c) => sum + c.estimatedTokens, 0);

    logger.info(
        {
            totalFiles: parsedDiff.files.length,
            reviewable: reviewable.length,
            skipped: skipped.length,
            chunks: chunks.length,
            estimatedTokens: estimatedTotalTokens,
        },
        'Chunks extracted',
    );

    return {
        chunks,
        skipped,
        stats: {
            totalFiles: parsedDiff.files.length,
            reviewableFiles: reviewable.length,
            skippedFiles: skipped.length,
            totalChunks: chunks.length,
            estimatedTotalTokens,
        },
    };
}

// ─── File classification ────────────────────────────────────────────────

function classifyFile(filename: string): FilePriority {
    for (const rule of PRIORITY_RULES) {
        if (rule.pattern.test(filename)) {
            return rule.priority;
        }
    }
    return 'core'; // default: treat unknown source files as core
}

// ─── Directory grouping ─────────────────────────────────────────────────

interface FileWithPriority {
    file: DiffFile;
    priority: FilePriority;
}

function groupByDirectory(
    files: FileWithPriority[],
): Map<string, FileWithPriority[]> {
    const groups = new Map<string, FileWithPriority[]>();

    for (const entry of files) {
        // Use parent directory as group key, or 'root' for top-level files
        const parts = entry.file.filename.split('/');
        const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : 'root';

        const group = groups.get(dir) ?? [];
        group.push(entry);
        groups.set(dir, group);
    }

    return groups;
}

// ─── Chunk building ─────────────────────────────────────────────────────

function buildChunks(
    groups: Map<string, FileWithPriority[]>,
    maxTokens: number,
): ReviewableChunk[] {
    const chunks: ReviewableChunk[] = [];

    for (const [dir, groupFiles] of groups.entries()) {
        // Sort within group by priority
        groupFiles.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);

        let currentFiles: DiffFile[] = [];
        let currentTokens = 0;
        let currentPriority: FilePriority = groupFiles[0]?.priority ?? 'core';

        for (const entry of groupFiles) {
            const fileTokens = estimateFileTokens(entry.file);

            // If single file exceeds limit, give it its own chunk (will be truncated by LLM)
            if (fileTokens > maxTokens) {
                // Flush current chunk
                if (currentFiles.length > 0) {
                    chunks.push(createChunk(currentFiles, currentPriority, currentTokens, dir));
                    currentFiles = [];
                    currentTokens = 0;
                }

                // Large file gets its own chunk
                chunks.push(createChunk([entry.file], entry.priority, fileTokens, `${dir} (large file)`));
                continue;
            }

            // If adding this file would exceed limit, start new chunk
            if (currentTokens + fileTokens > maxTokens && currentFiles.length > 0) {
                chunks.push(createChunk(currentFiles, currentPriority, currentTokens, dir));
                currentFiles = [];
                currentTokens = 0;
                currentPriority = entry.priority;
            }

            currentFiles.push(entry.file);
            currentTokens += fileTokens;

            // Use highest priority in the chunk
            if (PRIORITY_ORDER[entry.priority] < PRIORITY_ORDER[currentPriority]) {
                currentPriority = entry.priority;
            }
        }

        // Flush remaining files
        if (currentFiles.length > 0) {
            chunks.push(createChunk(currentFiles, currentPriority, currentTokens, dir));
        }
    }

    return chunks;
}

function createChunk(
    files: DiffFile[],
    priority: FilePriority,
    tokens: number,
    reason: string,
): ReviewableChunk {
    return {
        id: '',  // assigned later
        files,
        priority,
        estimatedTokens: tokens,
        reason: `${reason} (${files.length} file${files.length === 1 ? '' : 's'})`,
    };
}

/**
 * Estimate token count for a file's diff content.
 * Uses character count / CHARS_PER_TOKEN as approximation.
 */
function estimateFileTokens(file: DiffFile): number {
    let chars = 0;

    // Filename and metadata
    chars += file.filename.length + 50;

    // Hunk content
    for (const hunk of file.hunks) {
        chars += hunk.header.length;
        for (const line of hunk.lines) {
            chars += line.content.length + 5; // +5 for line prefix/type markup
        }
    }

    return Math.ceil(chars / CHARS_PER_TOKEN);
}
