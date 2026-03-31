import { Octokit } from '@octokit/rest';
import { logger } from '../config/logger.js';

const REQUIRED_PERMISSIONS: Record<string, string> = {
    pull_requests: 'write',
    contents: 'read',
    metadata: 'read',
    checks: 'write',
};

/**
 * Validate that an installation has the required permissions.
 */
export async function validatePermissions(
    octokit: Octokit,
): Promise<{ valid: boolean; missing: string[] }> {
    try {
        const { data } = await octokit.rest.apps.getAuthenticated();
        const permissions = ((data as Record<string, unknown>)?.permissions ?? {}) as Record<string, string>;
        const missing: string[] = [];

        for (const [perm, level] of Object.entries(REQUIRED_PERMISSIONS)) {
            const current = permissions[perm];
            if (!current || !hasMinimumPermission(current, level)) {
                missing.push(`${perm}: ${level} (current: ${current || 'none'})`);
            }
        }

        if (missing.length > 0) {
            logger.warn({ missing }, 'Installation missing required permissions');
        }

        return { valid: missing.length === 0, missing };
    } catch (error) {
        logger.error({ err: error }, 'Failed to validate permissions');
        return { valid: false, missing: ['Unable to fetch app permissions'] };
    }
}

function hasMinimumPermission(current: string, required: string): boolean {
    const levels = ['read', 'write', 'admin'];
    return levels.indexOf(current) >= levels.indexOf(required);
}
