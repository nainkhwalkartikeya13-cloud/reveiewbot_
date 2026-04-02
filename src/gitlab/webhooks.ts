import { Router, Request, Response } from 'express';
import { logger } from '../config/logger.js';
import { enqueueReviewJob } from '../queue/review.queue.js';

// ═══════════════════════════════════════════════════════════════════════
// GitLab Webhook Handler
// ═══════════════════════════════════════════════════════════════════════
//
// Handles GitLab webhook events for Merge Request reviews.
//
// GitLab webhook setup:
//  1. Go to Project → Settings → Webhooks
//  2. URL: https://your-domain.com/api/gitlab/webhooks
//  3. Secret token: GITLAB_WEBHOOK_SECRET from env
//  4. Trigger: Merge request events
//  5. Enable SSL verification

export const gitlabWebhookRouter = Router();

/**
 * Validate the X-Gitlab-Token header against GITLAB_WEBHOOK_SECRET.
 */
function validateGitLabToken(req: Request): boolean {
    const secret = process.env.GITLAB_WEBHOOK_SECRET;
    if (!secret) {
        logger.warn('GITLAB_WEBHOOK_SECRET is not set, rejecting all GitLab webhooks');
        return false;
    }

    const token = req.headers['x-gitlab-token'] as string | undefined;
    return token === secret;
}

/**
 * POST /api/gitlab/webhooks
 *
 * Handles GitLab merge_request webhook events:
 *  - open: new MR opened → enqueue review
 *  - update: MR pushed to → enqueue review (if commits changed)
 *  - reopen: MR reopened → enqueue review
 */
gitlabWebhookRouter.post('/', async (req: Request, res: Response) => {
    // ── Step 1: Validate webhook secret ────────────────────────────────

    if (!validateGitLabToken(req)) {
        logger.warn('Invalid GitLab webhook token');
        res.status(401).json({ error: 'Invalid token' });
        return;
    }

    // ── Step 2: Identify event type ─────────────────────────────────────

    const eventType = req.headers['x-gitlab-event'] as string | undefined;

    if (eventType !== 'Merge Request Hook') {
        logger.debug({ eventType }, 'Ignoring non-MR GitLab event');
        res.status(200).json({ status: 'ignored', reason: 'not_merge_request' });
        return;
    }

    // ── Step 3: Parse payload ───────────────────────────────────────────

    const payload = req.body;
    const attrs = payload?.object_attributes;

    if (!attrs) {
        logger.warn('GitLab webhook payload missing object_attributes');
        res.status(400).json({ error: 'Invalid payload' });
        return;
    }

    const action = attrs.action as string;
    const reviewableActions = ['open', 'update', 'reopen'];

    if (!reviewableActions.includes(action)) {
        logger.debug({ action }, 'Ignoring non-reviewable MR action');
        res.status(200).json({ status: 'ignored', reason: `action_${action}` });
        return;
    }

    // For "update" actions, only trigger if there's a new commit
    if (action === 'update' && !attrs.oldrev) {
        logger.debug('MR update without new commits (title/description change), skipping');
        res.status(200).json({ status: 'ignored', reason: 'no_new_commits' });
        return;
    }

    // ── Step 4: Extract MR data ─────────────────────────────────────────

    const project = payload.project;
    const projectId = project?.id as number;
    const projectFullName = project?.path_with_namespace as string;
    const mrIid = attrs.iid as number;
    const sourceBranch = attrs.source_branch as string;
    const targetBranch = attrs.target_branch as string;
    const authorUsername = payload.user?.username as string || attrs.author_id?.toString() || 'unknown';
    const title = attrs.title as string;
    const description = attrs.description as string | null;
    const headSha = attrs.last_commit?.id as string || '';
    const baseSha = attrs.oldrev as string || '';

    // Skip draft/WIP MRs
    if (attrs.draft || attrs.work_in_progress) {
        logger.info({ mrIid, projectFullName }, 'Skipping draft MR');
        res.status(200).json({ status: 'ignored', reason: 'draft' });
        return;
    }

    const log = logger.child({ platform: 'gitlab', projectId, mrIid, action });

    log.info(
        {
            projectFullName,
            sourceBranch,
            targetBranch,
            author: authorUsername,
        },
        'GitLab MR event received',
    );

    // ── Step 5: Enqueue review job ──────────────────────────────────────

    try {
        const jobId = await enqueueReviewJob({
            installationId: projectId,       // GitLab uses projectId in place of installationId
            repoFullName: projectFullName,
            repoGithubId: projectId,         // Store projectId in the githubId field
            prNumber: mrIid,
            title,
            body: description,
            headSha,
            baseSha,
            sender: authorUsername,
            action,
            language: null,
            platform: 'gitlab',              // New field: tells worker which platform to use
        });

        log.info({ jobId }, 'GitLab review job enqueued');

        res.status(200).json({
            status: 'queued',
            jobId,
            mrIid,
            project: projectFullName,
        });
    } catch (error) {
        log.error({ err: error }, 'Failed to enqueue GitLab review job');
        res.status(500).json({ error: 'Failed to enqueue review job' });
    }
});
