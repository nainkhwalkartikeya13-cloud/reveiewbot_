import { prisma } from '../db/client.js';
import { logger } from '../config/logger.js';

// Approximate pricing for Grok (per 1M tokens) — update as needed
const PRICE_PER_1M_INPUT_TOKENS = 2.0;
const PRICE_PER_1M_OUTPUT_TOKENS = 10.0;

export interface UsageTotals {
    reviewCount: number;
    promptTokens: number;
    completionTokens: number;
    estimatedCostUsd: number;
}

class UsageService {
    /**
     * Track usage for a review (upsert into daily bucket).
     */
    async trackUsage(
        installationId: string,
        promptTokens: number,
        completionTokens: number,
    ): Promise<void> {
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const cost =
            (promptTokens / 1_000_000) * PRICE_PER_1M_INPUT_TOKENS +
            (completionTokens / 1_000_000) * PRICE_PER_1M_OUTPUT_TOKENS;

        try {
            await prisma.usageRecord.upsert({
                where: {
                    installationId_date: {
                        installationId,
                        date: today,
                    },
                },
                create: {
                    installationId,
                    date: today,
                    reviewCount: 1,
                    totalPromptTokens: promptTokens,
                    totalCompletionTokens: completionTokens,
                    estimatedCostUsd: cost,
                },
                update: {
                    reviewCount: { increment: 1 },
                    totalPromptTokens: { increment: promptTokens },
                    totalCompletionTokens: { increment: completionTokens },
                    estimatedCostUsd: { increment: cost },
                },
            });
        } catch (error) {
            logger.error({ err: error, installationId }, 'Failed to track usage');
            // Non-critical — don't throw
        }
    }

    /**
     * Get usage summary for an installation over a date range.
     */
    async getUsageSummary(
        installationId: string,
        startDate: Date,
        endDate: Date,
    ) {
        const records = await prisma.usageRecord.findMany({
            where: {
                installationId,
                date: { gte: startDate, lte: endDate },
            },
            orderBy: { date: 'asc' },
        });

        const totals = records.reduce<UsageTotals>(
            (acc, r) => ({
                reviewCount: acc.reviewCount + r.reviewCount,
                promptTokens: acc.promptTokens + r.totalPromptTokens,
                completionTokens: acc.completionTokens + r.totalCompletionTokens,
                estimatedCostUsd: acc.estimatedCostUsd + r.estimatedCostUsd,
            }),
            { reviewCount: 0, promptTokens: 0, completionTokens: 0, estimatedCostUsd: 0 },
        );

        return { records, totals };
    }
}

export const usageService = new UsageService();
