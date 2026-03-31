// Smoke test: verify all modules can be imported and basic functions work at runtime
// Run with: npx tsx tests/smoke.ts

import { parseDiff } from '../src/github/diff-parser.js';
import { extractReviewableChunks } from '../src/github/chunk-extractor.js';
import { buildReviewStats, formatStatsSummary } from '../src/github/stats-builder.js';
import { getSystemPrompt, buildReviewPrompt, buildRepairPrompt } from '../src/llm/prompts.js';
import { parseLLMResponse, LLMParseError } from '../src/llm/parser.js';
import { RepoConfigSchema, DEFAULT_REPO_CONFIG, configToPromptContext } from '../src/types/config.types.js';
import { LLMReviewResponseSchema, ReviewIssueSchema, issuesToComments } from '../src/types/review.types.js';
import type { ReviewableChunk } from '../src/types/diff.types.js';

let passed = 0;
let failed = 0;

function assert(label: string, fn: () => void) {
    try {
        fn();
        console.log(`  ✅ ${label}`);
        passed++;
    } catch (e) {
        console.log(`  ❌ ${label}: ${(e as Error).message}`);
        failed++;
    }
}

console.log('\n🔍 AXD Smoke Tests\n');

// ── 1. Diff Parser ──────────────────────────────────────────────────────
console.log('📂 Diff Parser');

assert('parseDiff returns empty for empty input', () => {
    const r = parseDiff('');
    if (r.files.length !== 0) throw new Error(`Expected 0 files, got ${r.files.length}`);
    if (r.totalAdditions !== 0) throw new Error(`Expected 0 additions`);
});

const SAMPLE_DIFF = `diff --git a/src/auth.ts b/src/auth.ts
index abc..def 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,6 +10,8 @@ export class AuthService {
   async login(email: string, password: string) {
     const user = await this.findUser(email);
+    if (!user) throw new Error('User not found');
+    const valid = await bcrypt.compare(password, user.hash);
     return user;
   }
 }
diff --git a/package-lock.json b/package-lock.json
index aaa..bbb 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1 +1 @@
-old
+new
`;

assert('parseDiff parses multiple files with line numbers', () => {
    const r = parseDiff(SAMPLE_DIFF);
    if (r.files.length !== 2) throw new Error(`Expected 2 files, got ${r.files.length}`);
    if (r.files[0].filename !== 'src/auth.ts') throw new Error(`Wrong filename: ${r.files[0].filename}`);
    if (r.files[0].additions !== 2) throw new Error(`Expected 2 additions, got ${r.files[0].additions}`);
    if (r.files[0].hunks.length !== 1) throw new Error(`Expected 1 hunk`);
    if (r.files[0].language !== 'typescript') throw new Error(`Wrong language: ${r.files[0].language}`);
    // Check line numbers
    const addLines = r.files[0].hunks[0].lines.filter(l => l.type === 'add');
    if (addLines.length !== 2) throw new Error(`Expected 2 add lines`);
    if (addLines[0].newLineNumber !== 12) throw new Error(`Wrong line number: ${addLines[0].newLineNumber}`);
});

assert('parseDiff detects binary files', () => {
    const r = parseDiff(`diff --git a/image.png b/image.png
new file mode 100644
Binary files /dev/null and b/image.png differ
`);
    if (r.files.length !== 1) throw new Error(`Expected 1 file`);
    if (!r.files[0].isBinary) throw new Error(`Expected binary`);
});

assert('parseDiff detects renames', () => {
    const r = parseDiff(`diff --git a/old.ts b/new.ts
rename from old.ts
rename to new.ts
`);
    if (r.files[0].status !== 'renamed') throw new Error(`Expected renamed`);
    if (r.files[0].oldFilename !== 'old.ts') throw new Error(`Wrong old name`);
});

// ── 2. Chunk Extractor ──────────────────────────────────────────────────
console.log('\n📦 Chunk Extractor');

assert('extractReviewableChunks filters lock files', () => {
    const parsed = parseDiff(SAMPLE_DIFF);
    const result = extractReviewableChunks(parsed);
    // package-lock.json should be skipped
    if (result.skipped.length !== 1) throw new Error(`Expected 1 skipped, got ${result.skipped.length}`);
    if (!result.skipped[0].reason.includes('lock file')) throw new Error(`Wrong skip reason: ${result.skipped[0].reason}`);
    if (result.chunks.length !== 1) throw new Error(`Expected 1 chunk, got ${result.chunks.length}`);
});

assert('extractReviewableChunks classifies security files', () => {
    const parsed = parseDiff(SAMPLE_DIFF);
    const result = extractReviewableChunks(parsed);
    if (result.chunks[0].priority !== 'security') throw new Error(`Expected security priority, got ${result.chunks[0].priority}`);
});

assert('extractReviewableChunks has token estimate', () => {
    const parsed = parseDiff(SAMPLE_DIFF);
    const result = extractReviewableChunks(parsed);
    if (result.chunks[0].estimatedTokens <= 0) throw new Error(`Expected positive token estimate`);
});

// ── 3. Stats Builder ────────────────────────────────────────────────────
console.log('\n📊 Stats Builder');

assert('buildReviewStats returns correct structure', () => {
    const parsed = parseDiff(SAMPLE_DIFF);
    const chunks = extractReviewableChunks(parsed);
    const stats = buildReviewStats(parsed, chunks);
    if (stats.complexityEstimate !== 'trivial') throw new Error(`Expected trivial, got ${stats.complexityEstimate}`);
    if (stats.filesAnalyzed !== 1) throw new Error(`Expected 1 analyzed`);
    if (stats.filesSkipped !== 1) throw new Error(`Expected 1 skipped`);
    if (!stats.languageBreakdown['typescript']) throw new Error(`Missing typescript in breakdown`);
    if (stats.riskAreas.length === 0) throw new Error(`Expected risk areas for auth file`);
});

assert('formatStatsSummary returns markdown', () => {
    const parsed = parseDiff(SAMPLE_DIFF);
    const chunks = extractReviewableChunks(parsed);
    const stats = buildReviewStats(parsed, chunks);
    const md = formatStatsSummary(stats);
    if (!md.includes('AXD Review Summary')) throw new Error(`Missing header`);
    if (!md.includes('Complexity')) throw new Error(`Missing complexity`);
});

// ── 4. Config System ────────────────────────────────────────────────────
console.log('\n⚙️  Config System');

assert('DEFAULT_REPO_CONFIG has sensible defaults', () => {
    if (!DEFAULT_REPO_CONFIG.review_focus.includes('security')) throw new Error(`Missing security focus`);
    if (DEFAULT_REPO_CONFIG.severity_threshold !== 'medium') throw new Error(`Wrong threshold`);
    if (DEFAULT_REPO_CONFIG.max_files_per_review !== 25) throw new Error(`Wrong max files`);
    if (DEFAULT_REPO_CONFIG.auto_approve_if_no_issues !== false) throw new Error(`Should default to false`);
});

assert('RepoConfigSchema validates custom rules', () => {
    const cfg = RepoConfigSchema.parse({
        custom_rules: ['Check for SQL injection', 'Enforce async/await'],
        review_focus: ['security', 'performance'],
    });
    if (cfg.custom_rules.length !== 2) throw new Error(`Expected 2 rules`);
});

assert('configToPromptContext generates prompt text', () => {
    const cfg = RepoConfigSchema.parse({
        custom_rules: ['Always use parameterized queries'],
        review_focus: ['security', 'database'],
        language_hints: { primary: 'typescript', frameworks: ['express', 'prisma'] },
    });
    const ctx = configToPromptContext(cfg);
    if (!ctx.includes('parameterized queries')) throw new Error(`Missing custom rule`);
    if (!ctx.includes('security')) throw new Error(`Missing focus area`);
    if (!ctx.includes('typescript')) throw new Error(`Missing language hint`);
    if (!ctx.includes('express')) throw new Error(`Missing framework`);
});

// ── 5. LLM Types & Parser ──────────────────────────────────────────────
console.log('\n🧠 LLM Types & Parser');

assert('LLMReviewResponseSchema validates correct response', () => {
    const valid = LLMReviewResponseSchema.parse({
        summary: 'Good code',
        overallVerdict: 'approve',
        issues: [],
        positives: ['Clean abstractions'],
        questions: [],
    });
    if (valid.overallVerdict !== 'approve') throw new Error(`Wrong verdict`);
});

assert('LLMReviewResponseSchema rejects invalid verdict', () => {
    const result = LLMReviewResponseSchema.safeParse({
        summary: 'x', overallVerdict: 'INVALID', issues: [], positives: [], questions: [],
    });
    if (result.success) throw new Error(`Should have rejected`);
});

assert('parseLLMResponse strips markdown fences', () => {
    const input = '```json\n' + JSON.stringify({
        summary: 'test', overallVerdict: 'approve', issues: [], positives: [], questions: [],
    }) + '\n```';
    const result = parseLLMResponse(input);
    if (result.overallVerdict !== 'approve') throw new Error(`Wrong verdict`);
});

assert('parseLLMResponse throws on garbage', () => {
    try { parseLLMResponse('not json'); throw new Error('Should have thrown'); }
    catch (e) { if (!(e instanceof LLMParseError)) throw new Error(`Wrong error type`); }
});

assert('issuesToComments maps severity correctly', () => {
    const comments = issuesToComments([{
        severity: 'critical', type: 'security', filename: 'auth.ts', lineNumber: 42,
        title: 'SQL Injection', description: 'Parameterize', suggestion: 'Use $1',
    }]);
    if (comments[0].severity !== 'critical') throw new Error(`Wrong severity`);
    if (comments[0].category !== 'security') throw new Error(`Wrong category`);
    if (!comments[0].body.includes('SQL Injection')) throw new Error(`Missing title in body`);
});

// ── 6. Prompt Builder ───────────────────────────────────────────────────
console.log('\n📝 Prompt Builder');

assert('getSystemPrompt is substantial', () => {
    const prompt = getSystemPrompt();
    if (prompt.length < 2000) throw new Error(`Prompt too short: ${prompt.length} chars`);
    if (!prompt.includes('principal-level')) throw new Error(`Missing persona`);
    if (!prompt.includes('SQL injection')) throw new Error(`Missing bug pattern`);
    if (!prompt.includes('overallVerdict')) throw new Error(`Missing schema`);
});

assert('buildReviewPrompt includes all sections', () => {
    const parsed = parseDiff(SAMPLE_DIFF);
    const chunks = extractReviewableChunks(parsed);
    const chunk = chunks.chunks[0];

    const prompt = buildReviewPrompt(chunk, {
        title: 'Add auth validation',
        description: 'This PR adds proper password hashing',
        author: 'testuser',
        baseBranch: 'main',
        headBranch: 'feat/auth',
        language: 'typescript',
    }, {
        customInstructions: 'Always check for timing attacks',
        focusAreas: ['security'],
    });

    if (!prompt.includes('Add auth validation')) throw new Error(`Missing title`);
    if (!prompt.includes('testuser')) throw new Error(`Missing author`);
    if (!prompt.includes('timing attacks')) throw new Error(`Missing custom instruction`);
    if (!prompt.includes('src/auth.ts')) throw new Error(`Missing filename`);
    if (!prompt.includes('<diff>')) throw new Error(`Missing diff markers`);
});

assert('buildRepairPrompt references error', () => {
    const prompt = buildRepairPrompt('bad json', 'Unexpected token');
    if (!prompt.includes('Unexpected token')) throw new Error(`Missing error`);
    if (!prompt.includes('bad json')) throw new Error(`Missing response`);
});

// ── Summary ─────────────────────────────────────────────────────────────
console.log(`\n${'═'.repeat(50)}`);
console.log(`  Passed: ${passed}  |  Failed: ${failed}`);
console.log(`${'═'.repeat(50)}`);

if (failed > 0) {
    process.exit(1);
} else {
    console.log('\n🎉 ALL SMOKE TESTS PASSED\n');
}
