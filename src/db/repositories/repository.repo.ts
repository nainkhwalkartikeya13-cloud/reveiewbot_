import { prisma } from '../client.js';
import type { Repository } from '@prisma/client';
import type { RepoConfig } from '../../types/config.types.js';

export class RepositoryRepo {
    async upsert(data: {
        githubId: number;
        fullName: string;
        defaultBranch: string;
        installationId: string;
    }): Promise<Repository> {
        return prisma.repository.upsert({
            where: { githubId: data.githubId },
            create: data,
            update: {
                fullName: data.fullName,
                defaultBranch: data.defaultBranch,
            },
        });
    }

    async findByFullName(fullName: string): Promise<Repository | null> {
        return prisma.repository.findFirst({
            where: { fullName },
        });
    }

    async findByGithubId(githubId: number): Promise<Repository | null> {
        return prisma.repository.findUnique({
            where: { githubId },
        });
    }

    async findByInstallation(installationId: string): Promise<Repository[]> {
        return prisma.repository.findMany({
            where: { installationId },
            orderBy: { fullName: 'asc' },
        });
    }

    async updateConfig(id: string, config: Partial<RepoConfig>): Promise<Repository> {
        const current = await prisma.repository.findUniqueOrThrow({ where: { id } });
        const merged = { ...(current.config as object), ...config };
        return prisma.repository.update({
            where: { id },
            data: { config: merged },
        });
    }

    async setActive(id: string, isActive: boolean): Promise<Repository> {
        return prisma.repository.update({
            where: { id },
            data: { isActive },
        });
    }
}

export const repositoryRepo = new RepositoryRepo();
