import { Redis } from 'ioredis';
import { env } from './env.js';
import { logger } from './logger.js';

let redisInstance: Redis | null = null;

export function getRedisConnection(): Redis {
    if (redisInstance) {
        return redisInstance;
    }

    redisInstance = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: null, // required by BullMQ
        enableReadyCheck: false,
        retryStrategy(times: number) {
            const delay = Math.min(times * 200, 5000);
            logger.warn({ attempt: times, delay }, 'Redis reconnecting...');
            return delay;
        },
    });

    redisInstance.on('connect', () => {
        logger.info('Redis connected');
    });

    redisInstance.on('error', (err: Error) => {
        logger.error({ err }, 'Redis connection error');
    });

    return redisInstance;
}

export async function closeRedis(): Promise<void> {
    if (redisInstance) {
        await redisInstance.quit();
        redisInstance = null;
        logger.info('Redis connection closed');
    }
}
