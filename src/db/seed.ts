import { prisma } from './client.js';
import { logger } from '../config/logger.js';

async function seed() {
    logger.info('Seeding database...');

    // In development, you can add seed data here.
    // For now, just verify connectivity.
    const count = await prisma.installation.count();
    logger.info({ installationCount: count }, 'Database connected, seed complete');
}

seed()
    .catch((e) => {
        logger.error({ err: e }, 'Seed failed');
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
