import { parseLLMResponse, LLMParseError } from '../../../src/llm/parser.js';

const VALID_RESPONSE = {
    summary: 'Found 1 issue in authentication logic',
    overallVerdict: 'request_changes' as const,
    issues: [
        {
            severity: 'high' as const,
            type: 'security' as const,
            filename: 'src/auth.ts',
            lineNumber: 42,
            title: 'Missing password hash comparison',
            description: 'Plain text password comparison is vulnerable to timing attacks',
            suggestion: 'Use bcrypt.compare() for constant-time comparison',
            codeSnippet: 'const isValid = await bcrypt.compare(input, stored);',
        },
    ],
    positives: ['Good use of middleware pattern'],
    questions: ['Is rate limiting applied to this endpoint?'],
};

const CLEAN_RESPONSE = {
    summary: 'Clean code, no issues found',
    overallVerdict: 'approve' as const,
    issues: [],
    positives: ['Well-structured error handling', 'Good test coverage'],
    questions: [],
};

describe('parseLLMResponse', () => {
    it('should parse a valid review response with issues', () => {
        const input = JSON.stringify(VALID_RESPONSE);
        const result = parseLLMResponse(input);

        expect(result.issues).toHaveLength(1);
        expect(result.issues[0].severity).toBe('high');
        expect(result.issues[0].type).toBe('security');
        expect(result.issues[0].filename).toBe('src/auth.ts');
        expect(result.issues[0].lineNumber).toBe(42);
        expect(result.overallVerdict).toBe('request_changes');
        expect(result.positives).toHaveLength(1);
        expect(result.questions).toHaveLength(1);
    });

    it('should parse clean review with no issues', () => {
        const input = JSON.stringify(CLEAN_RESPONSE);
        const result = parseLLMResponse(input);

        expect(result.issues).toHaveLength(0);
        expect(result.overallVerdict).toBe('approve');
        expect(result.positives).toHaveLength(2);
        expect(result.summary).toBe('Clean code, no issues found');
    });

    it('should strip markdown ```json fences', () => {
        const input = '```json\n' + JSON.stringify(CLEAN_RESPONSE) + '\n```';
        const result = parseLLMResponse(input);
        expect(result.issues).toHaveLength(0);
        expect(result.overallVerdict).toBe('approve');
    });

    it('should strip plain ``` fences', () => {
        const input = '```\n' + JSON.stringify(CLEAN_RESPONSE) + '\n```';
        const result = parseLLMResponse(input);
        expect(result.summary).toBe('Clean code, no issues found');
    });

    it('should strip leading non-JSON text', () => {
        const input = 'Here is the review:\n' + JSON.stringify(CLEAN_RESPONSE);
        const result = parseLLMResponse(input);
        expect(result.overallVerdict).toBe('approve');
    });

    it('should throw LLMParseError on completely invalid JSON', () => {
        expect(() => parseLLMResponse('not json at all')).toThrow(LLMParseError);
    });

    it('should throw LLMParseError when required fields are missing', () => {
        const input = JSON.stringify({ summary: 'test' }); // missing overallVerdict, issues, etc.
        expect(() => parseLLMResponse(input)).toThrow(LLMParseError);
    });

    it('should throw LLMParseError on invalid issue severity', () => {
        const input = JSON.stringify({
            ...CLEAN_RESPONSE,
            issues: [{ ...VALID_RESPONSE.issues[0], severity: 'INVALID' }],
        });
        expect(() => parseLLMResponse(input)).toThrow(LLMParseError);
    });

    it('should throw LLMParseError on invalid verdict', () => {
        const input = JSON.stringify({ ...CLEAN_RESPONSE, overallVerdict: 'invalid' });
        expect(() => parseLLMResponse(input)).toThrow(LLMParseError);
    });

    it('should accept optional codeSnippet field', () => {
        const withSnippet = { ...VALID_RESPONSE };
        const withoutSnippet = {
            ...VALID_RESPONSE,
            issues: [{ ...VALID_RESPONSE.issues[0], codeSnippet: undefined }],
        };

        expect(parseLLMResponse(JSON.stringify(withSnippet)).issues[0].codeSnippet).toBe(
            'const isValid = await bcrypt.compare(input, stored);',
        );
        expect(parseLLMResponse(JSON.stringify(withoutSnippet)).issues[0].codeSnippet).toBeUndefined();
    });

    it('should parse all severity levels', () => {
        for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
            const input = JSON.stringify({
                ...VALID_RESPONSE,
                issues: [{ ...VALID_RESPONSE.issues[0], severity }],
            });
            expect(parseLLMResponse(input).issues[0].severity).toBe(severity);
        }
    });

    it('should parse all issue types', () => {
        for (const type of ['bug', 'security', 'performance', 'logic', 'style'] as const) {
            const input = JSON.stringify({
                ...VALID_RESPONSE,
                issues: [{ ...VALID_RESPONSE.issues[0], type }],
            });
            expect(parseLLMResponse(input).issues[0].type).toBe(type);
        }
    });

    it('should parse all verdict types', () => {
        for (const verdict of ['approve', 'request_changes', 'comment'] as const) {
            const input = JSON.stringify({ ...CLEAN_RESPONSE, overallVerdict: verdict });
            expect(parseLLMResponse(input).overallVerdict).toBe(verdict);
        }
    });
});
