import { prisma } from '../client.js';
import type { Installation, AccountType } from '@prisma/client';

export class InstallationRepo {
    async upsert(data: {
        githubId: number;
        accountLogin: string;
        accountType: AccountType;
    }): Promise<Installation> {
        return prisma.installation.upsert({
            where: { githubId: data.githubId },
            create: data,
            update: {
                accountLogin: data.accountLogin,
                accountType: data.accountType,
                suspendedAt: null,
            },
        });
    }

    async findByGithubId(githubId: number): Promise<Installation | null> {
        return prisma.installation.findUnique({
            where: { githubId },
            include: { repositories: true },
        });
    }

    async suspend(githubId: number): Promise<void> {
        await prisma.installation.update({
            where: { githubId },
            data: { suspendedAt: new Date() },
        });
    }

    async unsuspend(githubId: number): Promise<void> {
        await prisma.installation.update({
            where: { githubId },
            data: { suspendedAt: null },
        });
    }

    async delete(githubId: number): Promise<void> {
        await prisma.installation.delete({
            where: { githubId },
        });
    }

    async updateToken(githubId: number, token: string, expiresAt: Date): Promise<void> {
        await prisma.installation.update({
            where: { githubId },
            data: { accessToken: token, tokenExpiresAt: expiresAt },
        });
    }
}

export const installationRepo = new InstallationRepo();
