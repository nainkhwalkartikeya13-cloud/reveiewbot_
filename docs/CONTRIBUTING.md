# Contributing to ReviewCode

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

1. Fork and clone the repo
2. Follow [SETUP.md](SETUP.md) to get the dev environment running
3. Create a branch: `git checkout -b feature/your-feature`

## Code Style

- **TypeScript strict mode** — no `any` unless absolutely necessary
- **ESLint + Prettier** — run `npm run lint:fix && npm run format` before committing
- **Naming**: camelCase for variables/functions, PascalCase for classes/types/interfaces

## Project Architecture

```
src/config/   → Environment, logging, Redis (infrastructure concerns)
src/github/   → All GitHub API interaction (webhooks, diffs, comments)
src/llm/      → All Anthropic/Claude interaction (prompts, parsing)
src/queue/    → Job queue definitions and workers
src/db/       → Database client and repository pattern (data access)
src/services/ → Business logic orchestration
src/api/      → HTTP routes, controllers, middleware
src/types/    → Shared TypeScript type definitions
```

**Key principle**: Each layer only imports from layers below it. Services import from db/github/llm, but db never imports from services.

## Adding a New Feature

1. **Types first** — define interfaces in `src/types/`
2. **Data layer** — add repository methods in `src/db/repositories/`
3. **Integration** — add to `src/github/` or `src/llm/` if needed
4. **Service** — orchestrate in `src/services/`
5. **API** — expose via controller in `src/api/controllers/`
6. **Tests** — add unit tests in `tests/unit/`

## Running Tests

```bash
npm test              # All tests
npm run test:watch    # Watch mode
```

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Add tests for new functionality
- Update docs if the change affects setup or configuration
- Ensure CI passes (lint, typecheck, tests)

## Reporting Issues

Use GitHub Issues. Include:
- Steps to reproduce
- Expected vs actual behavior
- Node.js version, OS
- Relevant logs (redact secrets!)
