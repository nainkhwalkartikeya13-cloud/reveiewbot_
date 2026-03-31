import { Webhooks, createNodeMiddleware } from '@octokit/webhooks';
import type { RequestHandler } from 'express';
import { enqueueReviewJob } from '../queue/review.queue.js';
import { installationRepo } from '../db/repositories/installation.repo.js';
import { repositoryRepo } from '../db/repositories/repository.repo.js';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import type { AccountType } from '@prisma/client';

// ─── Webhooks instance ──────────────────────────────────────────────────

const webhooks = new Webhooks({
    secret: env.GITHUB_WEBHOOK_SECRET,
});

// ─── pull_request events ────────────────────────────────────────────────

webhooks.on(
    ['pull_request.opened', 'pull_request.synchronize', 'pull_request.reopened'],
    async ({ id, name, payload }) => {
        const pr = payload.pull_request;
        const repo = payload.repository;
        const installation = payload.installation;
        const sender = payload.sender;

        const log = logger.child({
            deliveryId: id,
            event: name,
            action: payload.action,
            prNumber: pr.number,
            repo: repo.full_name,
        });

        // ── Guard clauses ────────────────────────────────────────────────

        // Skip draft PRs
        if (pr.draft) {
            log.info('Skipping draft PR');
            return;
        }

        // Skip PRs opened by bots
        if (sender.type === 'Bot') {
            log.info({ sender: sender.login }, 'Skipping bot PR');
            return;
        }

        // Must have installation context
        if (!installation) {
            log.warn('Missing installation context in webhook payload');
            return;
        }

        // Check if repo is tracked and active in our DB
        const repoRecord = await repositoryRepo.findByGithubId(repo.id);
        if (!repoRecord || !repoRecord.isActive) {
            log.debug('Repo not tracked or reviews disabled');
            return;
        }

        // Check if this event/action is in the repo's reviewOn config
        const config = repoRecord.config as { reviewOn?: string[] };
        const reviewOn = config.reviewOn ?? ['opened', 'synchronize', 'reopened'];
        if (!reviewOn.includes(payload.action)) {
            log.debug({ action: payload.action }, 'Action not in reviewOn config, skipping');
            return;
        }

        // ── Enqueue review job ───────────────────────────────────────────

        const jobId = await enqueueReviewJob({
            installationId: installation.id,
            repoFullName: repo.full_name,
            repoGithubId: repo.id,
            prNumber: pr.number,
            title: pr.title,
            body: pr.body ?? null,
            headSha: pr.head.sha,
            baseSha: pr.base.sha,
            sender: sender.login,
            action: payload.action,
            language: repo.language ?? null,
        });

        log.info({ jobId }, 'Review job enqueued');
    },
);

// ─── installation events ────────────────────────────────────────────────

webhooks.on('installation.created', async ({ payload }) => {
    const inst = payload.installation;

    const account = inst.account as Record<string, unknown> | null;
    const accountLogin = account && 'login' in account ? String(account.login) : String(inst.id);
    const accountType = account && 'type' in account ? String(account.type).toUpperCase() : 'USER';

    const record = await installationRepo.upsert({
        githubId: inst.id,
        accountLogin,
        accountType: accountType as AccountType,
    });

    // Track all initially selected repositories
    const repos = payload.repositories ?? [];
    for (const r of repos) {
        await repositoryRepo.upsert({
            githubId: r.id,
            fullName: r.full_name,
            defaultBranch: 'main',
            installationId: record.id,
        });
    }

    logger.info(
        { installationId: inst.id, repoCount: repos.length },
        'Installation created',
    );
});

webhooks.on('installation.deleted', async ({ payload }) => {
    await installationRepo.delete(payload.installation.id);
    logger.info({ installationId: payload.installation.id }, 'Installation deleted');
});

webhooks.on('installation.suspend', async ({ payload }) => {
    await installationRepo.suspend(payload.installation.id);
    logger.info({ installationId: payload.installation.id }, 'Installation suspended');
});

webhooks.on('installation.unsuspend', async ({ payload }) => {
    await installationRepo.unsuspend(payload.installation.id);
    logger.info({ installationId: payload.installation.id }, 'Installation unsuspended');
});

// ─── installation_repositories events ───────────────────────────────────

webhooks.on('installation_repositories', async ({ payload }) => {
    const instId = payload.installation.id;
    if (!instId) {
        logger.warn('Missing installation ID in repos event');
        return;
    }
    const inst = await installationRepo.findByGithubId(instId);
    if (!inst) {
        logger.warn({ installationId: payload.installation.id }, 'Unknown installation');
        return;
    }

    for (const r of payload.repositories_added) {
        await repositoryRepo.upsert({
            githubId: r.id,
            fullName: r.full_name,
            defaultBranch: 'main',
            installationId: inst.id,
        });
    }

    for (const r of payload.repositories_removed) {
        if (!r.id) continue;
        const existing = await repositoryRepo.findByGithubId(r.id);
        if (existing) {
            await repositoryRepo.setActive(existing.id, false);
        }
    }

    logger.info(
        {
            added: payload.repositories_added.length,
            removed: payload.repositories_removed.length,
        },
        'Installation repos updated',
    );
});

// ─── Error handler ──────────────────────────────────────────────────────

webhooks.onError((error) => {
    logger.error({ err: error }, 'Webhook handler error');
});

// ─── Export the middleware ───────────────────────────────────────────────

/**
 * Express middleware that:
 *  1. Verifies the X-Hub-Signature-256 header (HMAC-SHA256)
 *  2. Parses the JSON body
 *  3. Routes to the correct event handler
 *
 * Mount at: app.use('/api/webhooks', webhookMiddleware)
 */
export const webhookMiddleware: RequestHandler = createNodeMiddleware(webhooks) as RequestHandler;
