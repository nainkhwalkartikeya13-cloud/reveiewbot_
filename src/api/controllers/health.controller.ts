import { Request, Response } from 'express';
import { prisma } from '../../db/client.js';
import { getReviewQueue } from '../../queue/review.queue.js';

export async function healthCheck(_req: Request, res: Response): Promise<void> {
    const checks: Record<string, boolean> = {};

    // Database check
    try {
        await prisma.$queryRaw`SELECT 1`;
        checks.database = true;
    } catch {
        checks.database = false;
    }

    // Redis check
    try {
        const queue = getReviewQueue();
        await queue.getJobCountByTypes('active', 'waiting');
        checks.redis = true;
    } catch {
        checks.redis = false;
    }

    const healthy = Object.values(checks).every(Boolean);

    res.status(healthy ? 200 : 503).json({
        status: healthy ? 'healthy' : 'degraded',
        checks,
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
    });
}
