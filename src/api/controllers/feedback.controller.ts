import { Request, Response } from 'express';
import { feedbackRepo } from '../../db/repositories/feedback.repo.js';
import type { Vote } from '@prisma/client';

/**
 * POST /api/feedback — Submit feedback on a review comment.
 */
export async function submitFeedback(req: Request, res: Response): Promise<void> {
    const { commentId, githubUsername, vote, reason } = req.body as {
        commentId: string;
        githubUsername: string;
        vote: string;
        reason?: string;
    };

    if (!commentId || !githubUsername || !vote) {
        res.status(400).json({ error: 'commentId, githubUsername, and vote are required' });
        return;
    }

    if (vote !== 'HELPFUL' && vote !== 'NOT_HELPFUL') {
        res.status(400).json({ error: 'vote must be HELPFUL or NOT_HELPFUL' });
        return;
    }

    const feedback = await feedbackRepo.upsert({
        commentId,
        githubUsername,
        vote: vote as Vote,
        reason,
    });

    res.status(201).json({ feedback });
}

/**
 * GET /api/feedback/:commentId — Get feedback stats for a comment.
 */
export async function getFeedbackStats(req: Request, res: Response): Promise<void> {
    const commentId = req.params.commentId as string;
    const stats = await feedbackRepo.getStats(commentId);
    res.json({ stats });
}
