import { Request, Response } from 'express';
import { reviewRepo } from '../../db/repositories/review.repo.js';

/**
 * GET /api/reviews — List reviews for a repository.
 */
export async function listReviews(req: Request, res: Response): Promise<void> {
    const repositoryId = req.query.repositoryId as string | undefined;
    const limit = parseInt((req.query.limit as string) || '20', 10) || 20;

    if (!repositoryId) {
        res.status(400).json({ error: 'repositoryId query parameter is required' });
        return;
    }

    const reviews = await reviewRepo.findRecent(repositoryId, limit);
    res.json({ reviews });
}

/**
 * GET /api/reviews/:id — Get a single review with comments.
 */
export async function getReview(req: Request, res: Response): Promise<void> {
    const id = req.params.id as string;
    const review = await reviewRepo.findById(id);

    if (!review) {
        res.status(404).json({ error: 'Review not found' });
        return;
    }

    res.json({ review });
}
