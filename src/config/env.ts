import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
    // GitHub App
    GITHUB_APP_ID: z.string().min(1, 'GITHUB_APP_ID is required'),
    GITHUB_APP_PRIVATE_KEY: z.string().min(1, 'GITHUB_APP_PRIVATE_KEY is required'),
    GITHUB_WEBHOOK_SECRET: z.string().min(1, 'GITHUB_WEBHOOK_SECRET is required'),
    GITHUB_CLIENT_ID: z.string().optional(),
    GITHUB_CLIENT_SECRET: z.string().optional(),

    // LLM Provider
    LLM_PROVIDER: z.enum(['groq', 'claude']).default('groq'),

    // Groq (LLM)
    GROQ_API_KEY: z.string().min(1, 'GROQ_API_KEY is required'),
    GROQ_MODEL: z.string().default('llama-3.3-70b-versatile'),
    GROQ_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
    GROQ_TIMEOUT_MS: z.coerce.number().int().positive().default(120000),

    // Database
    DATABASE_URL: z.string().url('DATABASE_URL must be a valid URL'),

    // Redis
    REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

    // Server
    PORT: z.coerce.number().int().positive().default(3000),
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

    // Queue
    QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(3),
    QUEUE_MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),
    QUEUE_RETRY_DELAY_MS: z.coerce.number().int().positive().default(5000),

    // Rate Limits
    MAX_FILES_PER_REVIEW: z.coerce.number().int().positive().default(20),
    MAX_DIFF_SIZE_BYTES: z.coerce.number().int().positive().default(500000),
    MAX_REVIEWS_PER_HOUR_PER_INSTALL: z.coerce.number().int().positive().default(30),

    // Optional
    API_KEY: z.string().min(1).optional(),
    SENTRY_DSN: z.string().url().optional(),

    // GitLab (optional — only needed for GitLab integration)
    GITLAB_WEBHOOK_SECRET: z.string().min(1).optional(),
    GITLAB_ACCESS_TOKEN: z.string().min(1).optional(),
    GITLAB_BASE_URL: z.string().url().default('https://gitlab.com'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
    const result = envSchema.safeParse(process.env);

    if (!result.success) {
        const formatted = result.error.format();
        const errors = Object.entries(formatted)
            .filter(([key]) => key !== '_errors')
            .map(([key, value]) => {
                const errs = (value as { _errors: string[] })._errors;
                return `  ${key}: ${errs.join(', ')}`;
            })
            .join('\n');

        console.error(`\n❌ Environment validation failed:\n${errors}\n`);
        process.exit(1);
    }

    return result.data;
}

export const env = loadEnv();
