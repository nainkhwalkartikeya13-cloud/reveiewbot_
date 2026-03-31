import { Octokit } from '@octokit/rest';
import { logger } from '../config/logger.js';
import type { DiffFile, FileContext, ContextSection } from '../types/diff.types.js';

// ─── Constants ──────────────────────────────────────────────────────────

/** Lines of surrounding context to fetch around each changed area */
const CONTEXT_LINES = 100;

/** Max file size in bytes to fetch (skip very large files) */
const MAX_FILE_SIZE = 500_000;  // 500KB

/** Max lines to return in context (prevent runaway for giant files) */
const MAX_CONTEXT_LINES = 5000;

// ─── File Context Builder ───────────────────────────────────────────────

/**
 * Fetch surrounding code context for a changed file so the LLM
 * understands what the changes relate to.
 *
 * For each hunk in the diff, fetches up to CONTEXT_LINES above and below
 * the changed area, merging overlapping sections.
 *
 * @param octokit   Authenticated Octokit instance
 * @param owner     Repo owner
 * @param repo      Repo name
 * @param file      Parsed diff file with hunks
 * @param ref       Git ref to fetch from (commit SHA or branch)
 * @returns         FileContext with relevant surrounding code
 */
export async function buildFileContext(
    octokit: Octokit,
    owner: string,
    repo: string,
    file: DiffFile,
    ref: string,
): Promise<FileContext> {
    // Skip binary files
    if (file.isBinary) {
        return {
            filename: file.filename,
            ref,
            fullContent: null,
            relevantSections: [],
            isTruncated: false,
        };
    }

    // Skip deleted files (nothing to fetch)
    if (file.status === 'deleted') {
        return {
            filename: file.filename,
            ref,
            fullContent: null,
            relevantSections: [],
            isTruncated: false,
        };
    }

    try {
        // Fetch file content from GitHub
        const content = await fetchFileContent(octokit, owner, repo, file.filename, ref);

        if (content === null) {
            logger.debug({ filename: file.filename }, 'File not found or too large');
            return {
                filename: file.filename,
                ref,
                fullContent: null,
                relevantSections: [],
                isTruncated: false,
            };
        }

        const lines = content.split('\n');
        const totalLines = lines.length;

        // If file is small enough, return it all
        if (totalLines <= MAX_CONTEXT_LINES) {
            return {
                filename: file.filename,
                ref,
                fullContent: content,
                relevantSections: [{
                    startLine: 1,
                    endLine: totalLines,
                    content,
                    reason: 'full file (small enough to include entirely)',
                }],
                isTruncated: false,
            };
        }

        // Extract relevant sections around each hunk
        const sections = extractSurroundingContext(file, lines, totalLines);

        return {
            filename: file.filename,
            ref,
            fullContent: null, // too large to include fully
            relevantSections: sections,
            isTruncated: true,
        };
    } catch (error) {
        logger.warn(
            { err: error, filename: file.filename, ref },
            'Failed to fetch file context',
        );
        return {
            filename: file.filename,
            ref,
            fullContent: null,
            relevantSections: [],
            isTruncated: false,
        };
    }
}

// ─── File content fetcher ───────────────────────────────────────────────

async function fetchFileContent(
    octokit: Octokit,
    owner: string,
    repo: string,
    path: string,
    ref: string,
): Promise<string | null> {
    try {
        const { data } = await octokit.rest.repos.getContent({
            owner,
            repo,
            path,
            ref,
        });

        // getContent returns array for directories
        if (Array.isArray(data)) return null;

        // Check size
        if ('size' in data && data.size > MAX_FILE_SIZE) {
            logger.debug(
                { filename: path, size: data.size, limit: MAX_FILE_SIZE },
                'File too large for context',
            );
            return null;
        }

        // Decode base64 content
        if ('content' in data && data.content && data.encoding === 'base64') {
            return Buffer.from(data.content, 'base64').toString('utf8');
        }

        // For files encoded differently or missing content,
        // fall back to raw download
        if ('download_url' in data && data.download_url) {
            const response = await fetch(data.download_url);
            if (!response.ok) return null;

            const text = await response.text();
            if (text.length > MAX_FILE_SIZE) return null;

            return text;
        }

        return null;
    } catch (error) {
        // 404 = file doesn't exist at this ref (new file, maybe)
        const e = error as { status?: number };
        if (e.status === 404) return null;
        throw error;
    }
}

// ─── Context section extraction ─────────────────────────────────────────

function extractSurroundingContext(
    file: DiffFile,
    lines: string[],
    totalLines: number,
): ContextSection[] {
    // Compute the line ranges we want context for
    interface RawRange {
        start: number;
        end: number;
        hunkLine: number;
    }

    const ranges: RawRange[] = [];

    for (const hunk of file.hunks) {
        const rangeStart = Math.max(1, hunk.startLine - CONTEXT_LINES);
        const rangeEnd = Math.min(totalLines, hunk.endLine + CONTEXT_LINES);

        ranges.push({
            start: rangeStart,
            end: rangeEnd,
            hunkLine: hunk.startLine,
        });
    }

    if (ranges.length === 0) return [];

    // Merge overlapping or adjacent ranges
    ranges.sort((a, b) => a.start - b.start);
    const merged: RawRange[] = [ranges[0]];

    for (let i = 1; i < ranges.length; i++) {
        const last = merged[merged.length - 1];
        const curr = ranges[i];

        if (curr.start <= last.end + 1) {
            // Ranges overlap or are adjacent — merge
            last.end = Math.max(last.end, curr.end);
        } else {
            merged.push(curr);
        }
    }

    // Build sections from merged ranges
    const sections: ContextSection[] = [];

    for (const range of merged) {
        const sectionLines = lines.slice(range.start - 1, range.end);
        sections.push({
            startLine: range.start,
            endLine: range.end,
            content: sectionLines.join('\n'),
            reason: `surrounding hunk at line ${range.hunkLine} (±${CONTEXT_LINES} lines)`,
        });
    }

    // Safety: cap total context lines
    let totalContextLines = 0;
    const capped: ContextSection[] = [];

    for (const section of sections) {
        const sectionLineCount = section.endLine - section.startLine + 1;
        if (totalContextLines + sectionLineCount > MAX_CONTEXT_LINES) {
            // Include partial section
            const remaining = MAX_CONTEXT_LINES - totalContextLines;
            if (remaining > 0) {
                const partialLines = section.content.split('\n').slice(0, remaining);
                capped.push({
                    startLine: section.startLine,
                    endLine: section.startLine + remaining - 1,
                    content: partialLines.join('\n'),
                    reason: `${section.reason} [truncated]`,
                });
            }
            break;
        }
        capped.push(section);
        totalContextLines += sectionLineCount;
    }

    return capped;
}
