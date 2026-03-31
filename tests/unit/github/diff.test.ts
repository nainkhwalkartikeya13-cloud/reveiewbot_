import { parseDiff, filterFiles } from '../../../src/github/diff.js';

const SAMPLE_DIFF = `diff --git a/src/app.ts b/src/app.ts
index abc1234..def5678 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,5 +1,7 @@
 import express from 'express';
+import cors from 'cors';
 
 const app = express();
+app.use(cors());
 
 export default app;
diff --git a/src/utils.ts b/src/utils.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/utils.ts
@@ -0,0 +1,5 @@
+export function add(a: number, b: number): number {
+  return a + b;
+}
+
+export const PI = 3.14159;
`;

describe('parseDiff', () => {
    it('should parse multiple files from a diff', () => {
        const files = parseDiff(SAMPLE_DIFF);
        expect(files).toHaveLength(2);
    });

    it('should detect file paths correctly', () => {
        const files = parseDiff(SAMPLE_DIFF);
        expect(files[0].path).toBe('src/app.ts');
        expect(files[1].path).toBe('src/utils.ts');
    });

    it('should detect file status', () => {
        const files = parseDiff(SAMPLE_DIFF);
        expect(files[0].status).toBe('modified');
        expect(files[1].status).toBe('added');
    });

    it('should detect language from extension', () => {
        const files = parseDiff(SAMPLE_DIFF);
        expect(files[0].language).toBe('typescript');
    });

    it('should count additions and deletions', () => {
        const files = parseDiff(SAMPLE_DIFF);
        expect(files[0].additions).toBe(2);
        expect(files[0].deletions).toBe(0);
    });

    it('should return empty array for empty diff', () => {
        expect(parseDiff('')).toHaveLength(0);
    });
});

describe('filterFiles', () => {
    const files = parseDiff(SAMPLE_DIFF);

    it('should include all files with default globs', () => {
        const result = filterFiles(files, ['**/*'], []);
        expect(result).toHaveLength(2);
    });

    it('should exclude files matching exclude globs', () => {
        const result = filterFiles(files, ['**/*'], ['**/*.ts']);
        expect(result).toHaveLength(0);
    });

    it('should include only files matching include globs', () => {
        const result = filterFiles(files, ['src/app.*'], []);
        expect(result).toHaveLength(1);
        expect(result[0].path).toBe('src/app.ts');
    });
});
