import { Request, Response } from 'express';
import { repositoryRepo } from '../../db/repositories/repository.repo.js';
import { configService } from '../../services/config.service.js';

/**
 * GET /api/repos — List repos for an installation.
 */
export async function listRepos(req: Request, res: Response): Promise<void> {
    const installationId = req.query.installationId as string | undefined;

    if (!installationId) {
        res.status(400).json({ error: 'installationId query parameter is required' });
        return;
    }

    const repos = await repositoryRepo.findByInstallation(installationId);
    res.json({ repos });
}

/**
 * PATCH /api/repos/:id/config — Update repo configuration.
 */
export async function updateRepoConfig(req: Request, res: Response): Promise<void> {
    const id = req.params.id as string;
    const body = req.body as unknown;

    const validation = configService.validateUpdate(body);
    if (!validation.valid) {
        res.status(400).json({ error: 'Invalid config', details: validation.errors });
        return;
    }

    try {
        const repo = await repositoryRepo.updateConfig(id, validation.config!);
        res.json({ repo });
    } catch {
        res.status(404).json({ error: 'Repository not found' });
    }
}

/**
 * PATCH /api/repos/:id/toggle — Enable/disable reviews.
 */
export async function toggleRepo(req: Request, res: Response): Promise<void> {
    const id = req.params.id as string;
    const { isActive } = req.body as { isActive: boolean };

    if (typeof isActive !== 'boolean') {
        res.status(400).json({ error: 'isActive must be a boolean' });
        return;
    }

    try {
        const repo = await repositoryRepo.setActive(id, isActive);
        res.json({ repo });
    } catch {
        res.status(404).json({ error: 'Repository not found' });
    }
}
