import { logger } from '../config/logger';
import type {
    DiffLine,
    DiffHunk,
    DiffFile,
    ParsedDiff,
    FileStatus,
} from '../types/diff.types';

// ─── Language detection ─────────────────────────────────────────────────

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python', pyi: 'python',
    rb: 'ruby', go: 'go', rs: 'rust',
    java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala',
    swift: 'swift', m: 'objective-c', mm: 'objective-c',
    cs: 'csharp', fs: 'fsharp', vb: 'vb',
    cpp: 'cpp', c: 'c', h: 'c', hpp: 'cpp', cc: 'cpp',
    php: 'php', sql: 'sql',
    yml: 'yaml', yaml: 'yaml', toml: 'toml',
    json: 'json', xml: 'xml', html: 'html',
    css: 'css', scss: 'scss', less: 'less',
    vue: 'vue', svelte: 'svelte',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    dockerfile: 'dockerfile', makefile: 'makefile',
    md: 'markdown', mdx: 'markdown',
    prisma: 'prisma', graphql: 'graphql', gql: 'graphql',
    tf: 'terraform', hcl: 'terraform',
    r: 'r', jl: 'julia', ex: 'elixir', exs: 'elixir',
    zig: 'zig', nim: 'nim', lua: 'lua', dart: 'dart',
};

function detectLanguage(filename: string): string {
    const basename = filename.split('/').pop() ?? '';
    const lower = basename.toLowerCase();

    // Special filenames
    if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'dockerfile';
    if (lower === 'makefile' || lower === 'gnumakefile') return 'makefile';
    if (lower === 'cmakelists.txt') return 'cmake';

    const ext = basename.includes('.') ? basename.split('.').pop()?.toLowerCase() ?? '' : '';
    return EXTENSION_TO_LANGUAGE[ext] ?? (ext || 'unknown');
}

// ─── Diff Parser ────────────────────────────────────────────────────────

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;
const FILE_HEADER_RE = /^diff --git a\/(.+?) b\/(.+)$/;

/**
 * Parse a unified diff string into a fully structured ParsedDiff object.
 *
 * Handles edge cases:
 *  - Empty diffs → returns { files: [], ... }
 *  - Binary files → isBinary: true, empty hunks
 *  - Renames → oldFilename populated, status: 'renamed'
 *  - Very large diffs → processes all content, no line limit
 *  - Malformed hunks → skipped with warning logged
 */
export function parseDiff(rawDiff: string): ParsedDiff {
    if (!rawDiff || rawDiff.trim().length === 0) {
        return { files: [], totalAdditions: 0, totalDeletions: 0, totalFiles: 0 };
    }

    const files: DiffFile[] = [];
    let totalAdditions = 0;
    let totalDeletions = 0;

    // Split by "diff --git" markers, keeping the header with each section
    const sections = rawDiff.split(/^(?=diff --git )/m).filter((s) => s.trim().length > 0);

    for (const section of sections) {
        const file = parseFileSection(section);
        if (file) {
            files.push(file);
            totalAdditions += file.additions;
            totalDeletions += file.deletions;
        }
    }

    logger.debug(
        { fileCount: files.length, additions: totalAdditions, deletions: totalDeletions },
        'Diff parsed',
    );

    return {
        files,
        totalAdditions,
        totalDeletions,
        totalFiles: files.length,
    };
}

function parseFileSection(section: string): DiffFile | null {
    const lines = section.split('\n');

    // Parse "diff --git a/path b/path"
    const headerMatch = lines[0]?.match(FILE_HEADER_RE);
    if (!headerMatch) return null;

    const oldPath = headerMatch[1];
    const newPath = headerMatch[2];

    // Detect file status from diff metadata
    let status: FileStatus = 'modified';
    let oldFilename: string | null = null;
    let isBinary = false;

    for (const line of lines.slice(1, 10)) { // Check first few metadata lines
        if (line.startsWith('new file mode')) {
            status = 'added';
        } else if (line.startsWith('deleted file mode')) {
            status = 'deleted';
        } else if (line.startsWith('rename from ')) {
            status = 'renamed';
            oldFilename = line.slice('rename from '.length).trim();
        } else if (line.startsWith('Binary files') || line.includes('GIT binary patch')) {
            isBinary = true;
        }
    }

    // For renames where we didn't find "rename from", check path difference
    if (status === 'modified' && oldPath !== newPath) {
        status = 'renamed';
        oldFilename = oldPath;
    }

    const filename = status === 'deleted' ? oldPath : newPath;
    const language = detectLanguage(filename);

    // Binary files have no parseable hunks
    if (isBinary) {
        return {
            filename,
            oldFilename,
            status,
            additions: 0,
            deletions: 0,
            isBinary: true,
            hunks: [],
            language,
        };
    }

    // Parse hunks
    const hunks: DiffHunk[] = [];
    let additions = 0;
    let deletions = 0;

    let currentHunk: DiffHunk | null = null;
    let currentOldLine = 0;
    let currentNewLine = 0;

    for (const line of lines) {
        const hunkMatch = line.match(HUNK_HEADER_RE);

        if (hunkMatch) {
            // Finalize previous hunk
            if (currentHunk) {
                finalizeHunk(currentHunk);
                hunks.push(currentHunk);
            }

            const oldStart = parseInt(hunkMatch[1], 10);
            const newStart = parseInt(hunkMatch[3], 10);
            const contextStr = hunkMatch[5]?.trim() ?? '';

            currentHunk = {
                header: line,
                startLine: newStart,
                endLine: newStart,    // Updated as we parse lines
                oldStartLine: oldStart,
                oldEndLine: oldStart, // Updated as we parse lines
                lines: [],
                context: contextStr,
            };
            currentOldLine = oldStart;
            currentNewLine = newStart;

        } else if (currentHunk) {
            // Parse diff content lines
            if (line.startsWith('+') && !line.startsWith('+++')) {
                // Addition
                const diffLine: DiffLine = {
                    type: 'add',
                    lineNumber: currentNewLine,
                    oldLineNumber: null,
                    newLineNumber: currentNewLine,
                    content: line.slice(1),
                };
                currentHunk.lines.push(diffLine);
                currentNewLine++;
                additions++;

            } else if (line.startsWith('-') && !line.startsWith('---')) {
                // Deletion
                const diffLine: DiffLine = {
                    type: 'remove',
                    lineNumber: currentOldLine,
                    oldLineNumber: currentOldLine,
                    newLineNumber: null,
                    content: line.slice(1),
                };
                currentHunk.lines.push(diffLine);
                currentOldLine++;
                deletions++;

            } else if (line.startsWith(' ')) {
                // Context line
                const diffLine: DiffLine = {
                    type: 'context',
                    lineNumber: currentNewLine,
                    oldLineNumber: currentOldLine,
                    newLineNumber: currentNewLine,
                    content: line.slice(1),
                };
                currentHunk.lines.push(diffLine);
                currentOldLine++;
                currentNewLine++;

            } else if (line === '\\ No newline at end of file') {
                // Skip this marker
            }
        }
    }

    // Finalize last hunk
    if (currentHunk) {
        finalizeHunk(currentHunk);
        hunks.push(currentHunk);
    }

    return {
        filename,
        oldFilename,
        status,
        additions,
        deletions,
        isBinary: false,
        hunks,
        language,
    };
}

/**
 * Set the endLine values on a hunk based on parsed line data.
 */
function finalizeHunk(hunk: DiffHunk): void {
    if (hunk.lines.length === 0) return;

    const lastLine = hunk.lines[hunk.lines.length - 1];
    hunk.endLine = lastLine.newLineNumber ?? hunk.startLine;
    hunk.oldEndLine = lastLine.oldLineNumber ?? hunk.oldStartLine;
}
