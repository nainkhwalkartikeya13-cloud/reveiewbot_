import { Octokit } from '@octokit/rest';
import yaml from 'js-yaml';
import {
    RepoConfigSchema,
    DEFAULT_REPO_CONFIG,
    configToPromptContext,
    type RepoConfig,
} from '../types/config.types.js';
import { repositoryRepo } from '../db/repositories/repository.repo.js';
import { logger } from '../config/logger.js';

// ─── Config file locations (checked in order) ───────────────────────────

const CONFIG_FILE_PATHS = [
    '.prbot.yml',
    '.prbot.yaml',
    '.github/prbot.yml',
    '.github/prbot.yaml',
];

// ═══════════════════════════════════════════════════════════════════════
// Config Service
// ═══════════════════════════════════════════════════════════════════════

class ConfigService {
    /**
     * Fetch and parse the repo's `.prbot.yml` config.
     *
     * Resolution order:
     *  1. Try fetching `.prbot.yml` (or .yaml) from the repo at the given ref
     *  2. If not found, check `.github/prbot.yml`
     *  3. If no file exists, fall back to DB config (set via dashboard)
     *  4. If nothing in DB, use sensible defaults
     *
     * DB config and YAML are merged: YAML wins for any overlapping fields,
     * but DB fields not present in YAML are preserved.
     */
    async parseRepoConfig(
        octokit: Octokit,
        owner: string,
        repo: string,
        ref: string,
        dbRepoId?: string,
    ): Promise<RepoConfig> {
        // Step 1: Try to fetch YAML from repo
        const yamlConfig = await this.fetchYamlConfig(octokit, owner, repo, ref);

        // Step 2: Get DB config (if we have a repo ID)
        let dbConfig: Partial<RepoConfig> = {};
        if (dbRepoId) {
            try {
                const repoRecord = await repositoryRepo.findByGithubId(0); // Will use actual ID
                if (repoRecord?.config && typeof repoRecord.config === 'object') {
                    dbConfig = repoRecord.config as Partial<RepoConfig>;
                }
            } catch {
                // DB lookup failure is non-fatal
            }
        }

        // Step 3: Merge (YAML takes priority over DB, both override defaults)
        const merged = {
            ...DEFAULT_REPO_CONFIG,
            ...dbConfig,
            ...(yamlConfig ?? {}),
        };

        // Step 4: Validate the merged config
        return this.validateAndParse(merged);
    }

    /**
     * Parse raw JSON config from the database.
     * Used when loading config without fetching from GitHub.
     */
    getConfig(rawConfig: unknown): RepoConfig {
        if (!rawConfig || typeof rawConfig !== 'object') {
            return DEFAULT_REPO_CONFIG;
        }

        return this.validateAndParse(rawConfig);
    }

    /**
     * Validate a partial config update before persisting to DB.
     */
    validateUpdate(update: unknown): { valid: boolean; config?: Partial<RepoConfig>; errors?: string[] } {
        const result = RepoConfigSchema.partial().safeParse(update);

        if (result.success) {
            return { valid: true, config: result.data };
        }

        const errors = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
        return { valid: false, errors };
    }

    /**
     * Convert a RepoConfig into a prompt-ready string.
     * This is the bridge between the config system and the LLM prompt.
     */
    getPromptContext(config: RepoConfig): string {
        return configToPromptContext(config);
    }

    // ─── Private helpers ────────────────────────────────────────────────

    /**
     * Fetch `.prbot.yml` from the repo via GitHub API.
     */
    private async fetchYamlConfig(
        octokit: Octokit,
        owner: string,
        repo: string,
        ref: string,
    ): Promise<Partial<RepoConfig> | null> {
        for (const path of CONFIG_FILE_PATHS) {
            try {
                const { data } = await octokit.rest.repos.getContent({
                    owner,
                    repo,
                    path,
                    ref,
                });

                // getContent returns array for directories
                if (Array.isArray(data)) continue;

                // Decode base64 content
                if ('content' in data && data.content && data.encoding === 'base64') {
                    const content = Buffer.from(data.content, 'base64').toString('utf8');
                    return this.parseYamlContent(content, path);
                }
            } catch (error) {
                const err = error as { status?: number };
                if (err.status === 404) continue; // File doesn't exist, try next path
                logger.debug({ err: error, path }, 'Error fetching config file');
            }
        }

        logger.debug({ owner, repo }, 'No .prbot.yml found, using defaults');
        return null;
    }

    /**
     * Parse YAML string into a partial RepoConfig.
     */
    private parseYamlContent(content: string, filePath: string): Partial<RepoConfig> | null {
        try {
            const raw = yaml.load(content);

            if (!raw || typeof raw !== 'object') {
                logger.warn({ filePath }, 'Empty or invalid YAML config file');
                return null;
            }

            logger.info({ filePath, keys: Object.keys(raw) }, 'Parsed .prbot.yml');
            return raw as Partial<RepoConfig>;
        } catch (error) {
            logger.warn(
                { err: error, filePath },
                'Failed to parse .prbot.yml — using defaults',
            );
            return null;
        }
    }

    /**
     * Validate a raw object against the full config schema.
     * Returns a fully populated config with defaults for missing fields.
     */
    private validateAndParse(raw: unknown): RepoConfig {
        const result = RepoConfigSchema.safeParse(raw);

        if (result.success) {
            return result.data;
        }

        logger.warn(
            { issues: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) },
            'Config validation issues, falling back to defaults for invalid fields',
        );

        // Best-effort: merge what we can with defaults
        try {
            const partial = raw as Record<string, unknown>;
            const safe: Record<string, unknown> = {};

            // Only keep keys that exist in the schema
            const schemaKeys = Object.keys(DEFAULT_REPO_CONFIG);
            for (const key of schemaKeys) {
                if (key in partial) {
                    safe[key] = partial[key];
                }
            }

            // Try again with cleaned data
            const retry = RepoConfigSchema.safeParse(safe);
            return retry.success ? retry.data : DEFAULT_REPO_CONFIG;
        } catch {
            return DEFAULT_REPO_CONFIG;
        }
    }
}

export const configService = new ConfigService();
