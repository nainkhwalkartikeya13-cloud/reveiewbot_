import { Request, Response, NextFunction } from 'express';
import { logger } from '../../config/logger.js';

/**
 * Placeholder auth middleware.
 * In production, verify JWT from a GitHub App authorization flow or
 * validate an API key from the dashboard.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    // For MVP: check for a simple API key header
    const apiKey = req.headers['x-api-key'] as string;

    if (!apiKey) {
        // In development, allow unauthenticated access
        if (process.env.NODE_ENV === 'development') {
            next();
            return;
        }

        res.status(401).json({ error: 'Missing X-API-Key header' });
        return;
    }

    // TODO: Validate API key against stored keys (per-installation)
    // For now, just pass through if header is present
    logger.debug('API request authenticated');
    next();
}
