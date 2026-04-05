import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import * as Sentry from '@sentry/node';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { router } from './api/router.js';
import { webhookMiddleware } from './github/webhooks.js';
import { gitlabWebhookRouter } from './gitlab/webhooks.js';
import { startReviewWorker, stopReviewWorker } from './queue/review.worker.js';
import { closeReviewQueue } from './queue/review.queue.js';
import { closeRedis } from './config/redis.js';
import { prisma } from './db/client.js';

function main() {
    // ─── Initialize Sentry ────────────────────────────────────────────
    if (env.SENTRY_DSN) {
        Sentry.init({
            dsn: env.SENTRY_DSN,
            environment: env.NODE_ENV,
            tracesSampleRate: 1.0,
        });
        logger.info('Sentry initialized');
    }

    const app = express();

    // ─── Security headers ─────────────────────────────────────────────
    app.use(helmet());
    app.use(cors());

    // ─── Webhook endpoint ─────────────────────────────────────────────
    // @octokit/webhooks middleware handles:
    //   • Raw body parsing
    //   • HMAC-SHA256 signature verification via X-Hub-Signature-256
    //   • Event routing to registered handlers
    //
    // IMPORTANT: Mount this BEFORE express.json() — the webhook middleware
    // needs the raw body for signature verification.
    app.use('/api/webhooks', webhookMiddleware);

    // ─── JSON body parser (for all other routes) ──────────────────────
    app.use(express.json());

    // ─── REST API routes ──────────────────────────────────────────────
    app.use(router);

    // ─── GitLab webhook endpoint ──────────────────────────────────────
    // Uses standard JSON body (no HMAC), so it's mounted after express.json()
    app.use('/api/gitlab/webhooks', gitlabWebhookRouter);

    // ─── Sentry Error Handler ─────────────────────────────────────────
    if (env.SENTRY_DSN) {
        Sentry.setupExpressErrorHandler(app);
    }

    // ─── Start the background review worker ───────────────────────────
    startReviewWorker();

    // ─── Start HTTP server ────────────────────────────────────────────
    const server = app.listen(env.PORT, '0.0.0.0', () => {
        logger.info(
            {
                port: env.PORT,
                env: env.NODE_ENV,
                pid: process.pid,
            },
            '🚀 AXD server started',
        );
        logger.info('Webhook endpoint: POST /api/webhooks');
        logger.info('Health check:     GET  /health');
    });

    // ─── Graceful shutdown ────────────────────────────────────────────
    const shutdown = async (signal: string) => {
        logger.info({ signal }, 'Shutting down...');

        // 1. Stop accepting new HTTP requests
        server.close();

        // 2. Stop processing new jobs (finish in-flight ones)
        await stopReviewWorker();

        // 3. Close queue connection
        await closeReviewQueue();

        // 4. Close Redis
        await closeRedis();

        // 5. Close database
        await prisma.$disconnect();

        logger.info('Shutdown complete');
        process.exit(0);
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));

    process.on('unhandledRejection', (reason) => {
        logger.error({ reason }, 'Unhandled rejection');
    });

    process.on('uncaughtException', (err) => {
        logger.fatal({ err }, 'Uncaught exception');
        void shutdown('uncaughtException');
    });
}

try {
    main();
} catch (err) {
    logger.fatal({ err }, 'Failed to start');
    process.exit(1);
}
