import { GitHubPlatform } from './github.platform.js';
import { GitLabPlatform } from './gitlab.platform.js';
import type { ReviewPlatform } from './platform.interface.js';

// ═══════════════════════════════════════════════════════════════════════
// Platform Factory
// ═══════════════════════════════════════════════════════════════════════
//
// Returns the correct ReviewPlatform implementation based on the
// platform identifier. Singletons are cached for the process lifetime.

let githubPlatform: GitHubPlatform | null = null;
let gitlabPlatform: GitLabPlatform | null = null;

/**
 * Get the ReviewPlatform implementation for the given platform.
 */
export function getPlatform(platform: 'github' | 'gitlab'): ReviewPlatform {
    if (platform === 'github') {
        if (!githubPlatform) {
            githubPlatform = new GitHubPlatform();
        }
        return githubPlatform;
    }

    if (platform === 'gitlab') {
        const baseUrl = process.env.GITLAB_BASE_URL || 'https://gitlab.com';
        const token = process.env.GITLAB_ACCESS_TOKEN || '';

        if (!token) {
            throw new Error('GITLAB_ACCESS_TOKEN is required for GitLab integration');
        }

        if (!gitlabPlatform) {
            gitlabPlatform = new GitLabPlatform(baseUrl, token);
        }
        return gitlabPlatform;
    }

    throw new Error(`Unknown platform: ${platform}`);
}

// Re-export everything
export type { ReviewPlatform, PlatformContext, PlatformPRMetadata, PlatformReviewResult } from './platform.interface.js';
