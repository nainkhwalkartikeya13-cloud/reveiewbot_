import { prisma } from '../client.js';
import type { Review, ReviewComment, ReviewStatus, ReviewVerdict } from '@prisma/client';
import type { ReviewIssue, IssueSeverity, Verdict } from '../../types/review.types.js';

// ─── Enum mappers ───────────────────────────────────────────────────────

function mapSeverity(s: IssueSeverity): ReviewComment['severity'] {
    return s.toUpperCase() as ReviewComment['severity'];
}

function mapType(t: ReviewIssue['type']): ReviewComment['type'] {
    return t.toUpperCase() as ReviewComment['type'];
}

function mapVerdict(v: Verdict): ReviewVerdict {
    const map: Record<Verdict, ReviewVerdict> = {
        approve: 'APPROVE',
        request_changes: 'REQUEST_CHANGES',
        comment: 'COMMENT',
    };
    return map[v];
}

// ═══════════════════════════════════════════════════════════════════════

export class ReviewRepo {
    async create(data: {
        repositoryId: string;
        prNumber: number;
        headSha: string;
        baseSha: string;
        triggerAction: string;
        triggeredBy: string;
    }): Promise<Review> {
        return prisma.review.create({ data });
    }

    async updateStatus(
        id: string,
        status: ReviewStatus,
        extra: Partial<{
            verdict: Verdict;
            filesReviewed: number;
            commentsPosted: number;
            issuesBySeverity: Record<string, number>;
            promptTokens: number;
            completionTokens: number;
            durationMs: number;
            summary: string;
            errorMessage: string;
            completedAt: Date;
            githubReviewId: number;
            githubCommentId: number;
        }> = {},
    ): Promise<Review> {
        const { verdict, ...rest } = extra;
        return prisma.review.update({
            where: { id },
            data: {
                status,
                ...(verdict ? { verdict: mapVerdict(verdict) } : {}),
                ...rest,
            },
        });
    }

    /**
     * Save review issues as ReviewComment records.
     * Accepts the new ReviewIssue format from the LLM.
     */
    async addIssues(
        reviewId: string,
        issues: ReviewIssue[],
    ): Promise<ReviewComment[]> {
        const created = await prisma.$transaction(
            issues.map((issue) =>
                prisma.reviewComment.create({
                    data: {
                        reviewId,
                        path: issue.filename,
                        line: issue.lineNumber,
                        side: 'RIGHT',
                        severity: mapSeverity(issue.severity),
                        type: mapType(issue.type),
                        title: issue.title,
                        body: issue.description,
                        suggestion: issue.suggestion,
                        codeSnippet: issue.codeSnippet ?? null,
                    },
                }),
            ),
        );
        return created;
    }

    /**
     * Legacy addComments (backward compat for existing call sites).
     */
    async addComments(
        reviewId: string,
        comments: Array<{
            path: string;
            line: number;
            side: string;
            body: string;
            severity: string;
            category?: string;
            githubCommentId?: number;
        }>,
    ): Promise<ReviewComment[]> {
        const created = await prisma.$transaction(
            comments.map((c) =>
                prisma.reviewComment.create({
                    data: {
                        reviewId,
                        path: c.path,
                        line: c.line,
                        side: c.side,
                        body: c.body,
                        severity: c.severity.toUpperCase() as ReviewComment['severity'],
                        type: (c.category?.toUpperCase() ?? 'BUG') as ReviewComment['type'],
                        title: c.body.slice(0, 100),
                        githubCommentId: c.githubCommentId,
                    },
                }),
            ),
        );
        return created;
    }

    async findByPR(repositoryId: string, prNumber: number): Promise<Review[]> {
        return prisma.review.findMany({
            where: { repositoryId, prNumber },
            include: { comments: true },
            orderBy: { createdAt: 'desc' },
        });
    }

    async findById(id: string): Promise<Review | null> {
        return prisma.review.findUnique({
            where: { id },
            include: { comments: { include: { feedbacks: true } } },
        });
    }

    async findRecent(repositoryId: string, limit = 20): Promise<Review[]> {
        return prisma.review.findMany({
            where: { repositoryId },
            orderBy: { createdAt: 'desc' },
            take: limit,
            include: { comments: true },
        });
    }

    /**
     * Count reviews per installation in the last hour (for rate limiting).
     */
    async countRecentByInstallation(
        installationGithubId: number,
        windowMs: number = 3600_000,
    ): Promise<number> {
        const since = new Date(Date.now() - windowMs);
        return prisma.review.count({
            where: {
                createdAt: { gte: since },
                repository: {
                    installation: { githubId: installationGithubId },
                },
            },
        });
    }

    /**
     * Get feedback stats for all comments in a review.
     */
    async getReviewFeedbackStats(reviewId: string): Promise<{
        totalComments: number;
        helpful: number;
        notHelpful: number;
    }> {
        const comments = await prisma.reviewComment.findMany({
            where: { reviewId },
            include: { feedbacks: true },
        });

        let helpful = 0;
        let notHelpful = 0;
        for (const comment of comments) {
            for (const fb of comment.feedbacks) {
                if (fb.vote === 'HELPFUL') helpful++;
                else notHelpful++;
            }
        }

        return {
            totalComments: comments.length,
            helpful,
            notHelpful,
        };
    }
}

export const reviewRepo = new ReviewRepo();
