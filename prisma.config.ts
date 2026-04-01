import path from 'node:path';
import { defineConfig } from 'prisma/config';
import { env } from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    earlyAccess: true,
    schema: path.join(__dirname, 'prisma', 'schema.prisma'),
    datasource: {
        url: env.DATABASE_URL || 'postgresql://axd:axd_dev@localhost:5432/axd?schema=public',
    },
});
