// This module's diff functionality has been consolidated into src/github/app.ts
// Re-export for backward compatibility with any code that imports from here.

export { fetchPRDiff } from './app.js';

// Keep the pure utility functions here since they don't depend on Octokit

import { logger } from '../config/logger.js';
import type { FileDiff, DiffHunk } from '../types/github.types.js';

/**
 * Parse a unified diff string into per-file FileDiff objects.
 */
export function parseDiff(rawDiff: string): FileDiff[] {
    const files: FileDiff[] = [];
    const fileSections = rawDiff.split(/^diff --git /m).filter(Boolean);

    for (const section of fileSections) {
        const lines = section.split('\n');

        // Extract file path from "a/path b/path"
        const headerMatch = lines[0]?.match(/a\/(.+?) b\/(.+)/);
        if (!headerMatch) continue;

        const path = headerMatch[2];
        const language = detectLanguage(path);

        // Detect file status
        let status: FileDiff['status'] = 'modified';
        if (section.includes('new file mode')) status = 'added';
        else if (section.includes('deleted file mode')) status = 'removed';
        else if (section.includes('rename from')) status = 'renamed';

        // Parse hunks
        const hunks: DiffHunk[] = [];
        let additions = 0;
        let deletions = 0;

        const hunkHeaderRegex = /^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@(.*)$/;
        let currentHunk: DiffHunk | null = null;
        let hunkLines: string[] = [];

        for (const line of lines) {
            const hunkMatch = line.match(hunkHeaderRegex);

            if (hunkMatch) {
                // Save previous hunk
                if (currentHunk) {
                    currentHunk.content = hunkLines.join('\n');
                    hunks.push(currentHunk);
                }

                currentHunk = {
                    oldStart: parseInt(hunkMatch[1], 10),
                    oldLines: parseInt(hunkMatch[2] || '1', 10),
                    newStart: parseInt(hunkMatch[3], 10),
                    newLines: parseInt(hunkMatch[4] || '1', 10),
                    content: '',
                    context: hunkMatch[5]?.trim() || '',
                };
                hunkLines = [];
            } else if (currentHunk) {
                hunkLines.push(line);
                if (line.startsWith('+') && !line.startsWith('+++')) additions++;
                if (line.startsWith('-') && !line.startsWith('---')) deletions++;
            }
        }

        // Save last hunk
        if (currentHunk) {
            currentHunk.content = hunkLines.join('\n');
            hunks.push(currentHunk);
        }

        if (hunks.length > 0) {
            files.push({ path, language, status, hunks, additions, deletions });
        }
    }

    logger.debug({ fileCount: files.length }, 'Diff parsed');
    return files;
}

/**
 * Detect programming language from file extension.
 */
function detectLanguage(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const languageMap: Record<string, string> = {
        ts: 'typescript', tsx: 'typescript',
        js: 'javascript', jsx: 'javascript',
        py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
        java: 'java', kt: 'kotlin', swift: 'swift',
        cs: 'csharp', cpp: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
        php: 'php', sql: 'sql', yml: 'yaml', yaml: 'yaml',
        json: 'json', md: 'markdown',
        css: 'css', scss: 'scss', html: 'html',
        vue: 'vue', svelte: 'svelte',
        sh: 'bash', bash: 'bash', dockerfile: 'dockerfile',
    };
    return languageMap[ext] || ext;
}

/**
 * Filter files based on include/exclude glob patterns.
 */
export function filterFiles(
    files: FileDiff[],
    includeGlobs: string[],
    excludeGlobs: string[],
): FileDiff[] {
    return files.filter((file) => {
        for (const glob of excludeGlobs) {
            if (matchGlob(file.path, glob)) return false;
        }
        if (includeGlobs.length > 0 && includeGlobs[0] !== '**/*') {
            return includeGlobs.some((glob) => matchGlob(file.path, glob));
        }
        return true;
    });
}

function matchGlob(path: string, glob: string): boolean {
    const regexStr = glob
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '{{DOUBLESTAR}}')
        .replace(/\*/g, '[^/]*')
        .replace(/\{\{DOUBLESTAR\}\}/g, '.*');
    return new RegExp(`^${regexStr}$`).test(path);
}
