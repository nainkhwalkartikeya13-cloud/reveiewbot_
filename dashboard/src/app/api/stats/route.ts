import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET() {
    try {
        // Total PRs reviewed
        const totalReviews = await prisma.review.count({
            where: { status: "COMPLETED" },
        });

        // Total issues found (sum of commentsPosted — each is an issue)
        const issueAgg = await prisma.review.aggregate({
            where: { status: "COMPLETED" },
            _sum: { commentsPosted: true },
        });
        const totalIssues = issueAgg._sum.commentsPosted ?? 0;

        // Critical issues — count ReviewComments with severity CRITICAL
        const criticalCount = await prisma.reviewComment.count({
            where: { severity: "CRITICAL" },
        });

        // High issues
        const highCount = await prisma.reviewComment.count({
            where: { severity: "HIGH" },
        });

        // Connected repos (distinct repos that have had reviews)
        const repoCount = await prisma.review.groupBy({
            by: ["repositoryId"],
            where: { status: "COMPLETED" },
        });
        const connectedRepos = repoCount.length;

        // Approval rate
        const approvedCount = await prisma.review.count({
            where: { status: "COMPLETED", verdict: "APPROVE" },
        });
        const approvalRate =
            totalReviews > 0 ? Math.round((approvedCount / totalReviews) * 100) : 0;

        // Token usage
        const tokenAgg = await prisma.review.aggregate({
            where: { status: "COMPLETED" },
            _sum: { promptTokens: true, completionTokens: true },
        });

        // Activity: PRs per day for last 14 days
        const fourteenDaysAgo = new Date();
        fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

        const recentReviews = await prisma.review.findMany({
            where: {
                status: "COMPLETED",
                createdAt: { gte: fourteenDaysAgo },
            },
            select: { createdAt: true },
            orderBy: { createdAt: "asc" },
        });

        // Build daily activity buckets
        const activity: { date: string; reviews: number }[] = [];
        for (let i = 13; i >= 0; i--) {
            const d = new Date();
            d.setDate(d.getDate() - i);
            const dateStr = d.toISOString().slice(0, 10);
            const count = recentReviews.filter(
                (r) => r.createdAt.toISOString().slice(0, 10) === dateStr
            ).length;
            activity.push({
                date: dateStr,
                reviews: count,
            });
        }

        // Token usage & Cost from UsageRecords
        const usageAgg = await prisma.usageRecord.aggregate({
            _sum: { estimatedCostUsd: true },
        });
        const totalEstimatedCost = usageAgg._sum.estimatedCostUsd ?? 0;

        return NextResponse.json({
            totalReviews,
            totalIssues,
            criticalCount,
            highCount,
            connectedRepos,
            approvalRate,
            totalPromptTokens: tokenAgg._sum.promptTokens ?? 0,
            totalCompletionTokens: tokenAgg._sum.completionTokens ?? 0,
            totalEstimatedCost,
            activity,
        });
    } catch (error) {
        console.error("Stats API error:", error);
        return NextResponse.json(
            { error: "Failed to fetch stats" },
            { status: 500 }
        );
    }
}
