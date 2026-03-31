import { App as OctokitApp } from '@octokit/app';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

// ─── App singleton ──────────────────────────────────────────────────────

let app: OctokitApp | null = null;

export function getGitHubApp(): OctokitApp {
    if (app) return app;

    const privateKey = env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n');

    app = new OctokitApp({
        appId: env.GITHUB_APP_ID,
        privateKey,
        webhooks: { secret: env.GITHUB_WEBHOOK_SECRET },
    });

    return app;
}

// ─── Installation authentication ────────────────────────────────────────

/**
 * Create an Octokit instance authenticated as a specific installation.
 * Uses @octokit/auth-app which handles token caching and refresh.
 */
export function getInstallationOctokit(installationId: number): Promise<Octokit> {
    const privateKey = env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n');

    const octokit = new Octokit({
        authStrategy: createAppAuth,
        auth: {
            appId: env.GITHUB_APP_ID,
            privateKey,
            installationId,
        },
    });

    logger.debug({ installationId }, 'Created installation Octokit');
    return Promise.resolve(octokit);
}

// ─── PR data fetching ───────────────────────────────────────────────────

export interface PRMetadata {
    title: string;
    body: string | null;
    author: string;
    baseRef: string;
    headRef: string;
    baseSha: string;
    headSha: string;
    changedFiles: number;
    additions: number;
    deletions: number;
    draft: boolean;
}

/**
 * Fetch PR metadata (title, description, branches, author, etc.).
 */
export async function fetchPRMetadata(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullNumber: number,
): Promise<PRMetadata> {
    const { data: pr } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
    });

    return {
        title: pr.title,
        body: pr.body,
        author: pr.user?.login ?? 'unknown',
        baseRef: pr.base.ref,
        headRef: pr.head.ref,
        baseSha: pr.base.sha,
        headSha: pr.head.sha,
        changedFiles: pr.changed_files,
        additions: pr.additions,
        deletions: pr.deletions,
        draft: pr.draft ?? false,
    };
}

/**
 * Fetch the unified diff for a PR using the diff media type.
 * Returns raw diff string.
 */
export async function fetchPRDiff(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullNumber: number,
): Promise<string> {
    const { data } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: pullNumber,
        mediaType: { format: 'diff' },
    });

    // When requesting diff format, response is a string
    return data as unknown as string;
}

/**
 * Fetch individual file patches for a PR with pagination.
 */
export async function fetchPRFiles(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullNumber: number,
) {
    const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
    });

    return files.map((f) => ({
        filename: f.filename,
        status: f.status as 'added' | 'modified' | 'removed' | 'renamed',
        additions: f.additions,
        deletions: f.deletions,
        patch: f.patch ?? '',
    }));
}

// ─── Review comment posting ─────────────────────────────────────────────

export interface ReviewComment {
    path: string;
    line: number;
    side: 'RIGHT' | 'LEFT';
    body: string;
}

/**
 * Post an atomic PR review with inline comments.
 * All comments appear at once under a single review, avoiding notification spam.
 */
export async function postReview(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullNumber: number,
    commitId: string,
    body: string,
    comments: ReviewComment[],
): Promise<number> {
    const { data } = await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        commit_id: commitId,
        event: 'COMMENT',
        body,
        comments: comments.map((c) => ({
            path: c.path,
            line: c.line,
            side: c.side,
            body: c.body,
        })),
    });

    logger.info(
        { reviewId: data.id, commentCount: comments.length, owner, repo, pullNumber },
        'Review posted',
    );

    return data.id;
}

/**
 * Post a simple issue comment on a PR (for errors / skipped reviews).
 */
export async function postIssueComment(
    octokit: Octokit,
    owner: string,
    repo: string,
    pullNumber: number,
    body: string,
): Promise<void> {
    await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: pullNumber,
        body,
    });
}
