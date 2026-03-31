import { prisma } from '../client.js';
import type { Feedback, Vote } from '@prisma/client';

export class FeedbackRepo {
    async upsert(data: {
        commentId: string;
        githubUsername: string;
        vote: Vote;
        reason?: string;
    }): Promise<Feedback> {
        return prisma.feedback.upsert({
            where: {
                commentId_githubUsername: {
                    commentId: data.commentId,
                    githubUsername: data.githubUsername,
                },
            },
            create: data,
            update: {
                vote: data.vote,
                reason: data.reason,
            },
        });
    }

    async findByComment(commentId: string): Promise<Feedback[]> {
        return prisma.feedback.findMany({
            where: { commentId },
        });
    }

    async getStats(commentId: string): Promise<{ helpful: number; notHelpful: number }> {
        const [helpful, notHelpful] = await Promise.all([
            prisma.feedback.count({ where: { commentId, vote: 'HELPFUL' } }),
            prisma.feedback.count({ where: { commentId, vote: 'NOT_HELPFUL' } }),
        ]);
        return { helpful, notHelpful };
    }
}

export const feedbackRepo = new FeedbackRepo();
