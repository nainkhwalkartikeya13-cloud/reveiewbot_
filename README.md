<div align="center">
  <h1>🤖 ReviewCode</h1>
  <p><b>An intelligent, automated AI-powered Code Reviewer for GitHub Pull Requests & GitLab Merge Requests.</b></p>

  [![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
  [![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
  [![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=for-the-badge&logo=postgresql&logoColor=white)](https://www.postgresql.org/)
  [![Redis](https://img.shields.io/badge/Redis-DC382D?style=for-the-badge&logo=redis&logoColor=white)](https://redis.io/)
  [![GitHub Apps](https://img.shields.io/badge/GitHub_Apps-181717?style=for-the-badge&logo=github&logoColor=white)](https://docs.github.com/en/apps)
  [![GitLab](https://img.shields.io/badge/GitLab-FC6D26?style=for-the-badge&logo=gitlab&logoColor=white)](https://about.gitlab.com/)
</div>

---

## 📖 About The Project

**ReviewCode** is an enterprise-grade code review bot that acts as an automated Senior Developer. It supports both **GitHub Pull Requests** and **GitLab Merge Requests**, automatically reviewing code using powerful Large Language Models (LLMs) like Groq and Claude.

Instead of waiting hours for a human to review code, ReviewCode instantly parses the `git diff`, analyzes the new code for bugs, logic flaws, and security vulnerabilities, and publishes inline comments natively on the platform.

### ✨ Key Features

| Feature | Description |
|---|---|
| 🧠 **AI-Powered Analysis** | Identifies complex bugs, SQL injections, performance bottlenecks, and logic errors |
| ⚡ **Diff-Based Reviews** | Targets only newly modified lines, saving tokens and reducing noise |
| 🔄 **Async Job Queue** | Handles high-volume PR/MR events reliably using BullMQ + Redis |
| 🏷️ **Auto-Labeling** | Applies severity-based labels (`reviewcode: critical`, `reviewcode: approved`, etc.) |
| 💡 **One-Click Fixes** | GitHub suggestion syntax for instant code fix application |
| 🤖 **Slash Commands** | `@reviewcodebot /review` to trigger manual re-reviews, `@reviewcodebot /help` for commands |
| 📊 **Dashboard** | Next.js dashboard with review stats, activity charts, and recent reviews |
| 🛡️ **Deduplication** | Ignores duplicate commits to prevent webhook spam |
| 🔌 **Multi-Platform** | Supports both GitHub (App) and GitLab (Webhook) |
| ⚙️ **Repo Config** | Per-repo `.reviewcodereview.yml` for custom rules, ignore paths, and focus areas |
| 🎬 **GitHub Action** | Use as a CI action — 3 lines of YAML, no App installation needed |

---

## ⚡ Quick Start (GitHub Action)

Add to `.github/workflows/reviewcode-review.yml` and you're done:

```yaml
name: ReviewCode Code Review
on:
  pull_request:
    types: [opened, synchronize]
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: KartikeyaNainkhwal/reviewbot@v1
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

> **That's it.** Every PR will get an AI review with inline suggestions you can apply with one click.

## 🏗️ Architecture

```
┌─────────────┐     ┌─────────────┐
│  GitHub App  │     │   GitLab    │
│  Webhook     │     │  Webhook    │
└──────┬───────┘     └──────┬──────┘
       │                    │
       ▼                    ▼
┌──────────────────────────────────┐
│         Express.js Server        │
│  POST /api/webhooks (GitHub)     │
│  POST /api/gitlab/webhooks       │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│    BullMQ Job Queue (Redis)      │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│       Review Worker              │
│  1. Fetch diff (platform API)    │
│  2. Parse & chunk diff           │
│  3. LLM review (Groq/Claude)    │
│  4. Post results (via platform)  │
│  5. Apply labels                 │
│  6. Save to PostgreSQL           │
└──────────────────────────────────┘
```

---

## 🛠️ Technology Stack

| Layer | Technology |
|---|---|
| **Language** | TypeScript (Node.js v22) |
| **Server** | Express.js |
| **Database** | PostgreSQL + Prisma v7 |
| **Job Queue** | Redis + BullMQ |
| **GitHub API** | Octokit (`@octokit/webhooks`, `@octokit/rest`) |
| **GitLab API** | Axios (REST API v4) |
| **LLM** | Groq (llama-3.3-70b) / Claude (production) |
| **Dashboard** | Next.js 16 + Tailwind v4 + Recharts |
| **Testing** | Jest |
| **Containerization** | Docker & Docker Compose |

---

## 🚀 Getting Started

### Prerequisites
* [Node.js](https://nodejs.org/en/) (v18+)
* [Docker](https://www.docker.com/) (for PostgreSQL and Redis)
* A [GitHub App](https://docs.github.com/en/apps/creating-github-apps) or GitLab project with webhook access
* A free [Smee.io](https://smee.io/) channel for local webhook forwarding (GitHub)

### 1. Clone & Install

```bash
git clone https://github.com/KartikeyaNainkhwal/reviewbot.git
cd reviewbot
npm install --legacy-peer-deps
```

### 2. Start Infrastructure

```bash
docker-compose -f docker/docker-compose.yml up -d
```

### 3. Configure Environment

Create a `.env` file:

```env
# Server
PORT=3000
NODE_ENV=development

# Database & Queue
DATABASE_URL="postgresql://reviewcode:axd_pass@localhost:5432/reviewcode?schema=public"
REDIS_URL="redis://localhost:6379"

# GitHub App (required for GitHub)
GITHUB_APP_ID="your_app_id"
GITHUB_WEBHOOK_SECRET="your_webhook_secret"
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"

# LLM Provider
LLM_PROVIDER="groq"
GROQ_API_KEY="your_groq_api_key"

# GitLab (optional — only if using GitLab)
GITLAB_WEBHOOK_SECRET="your_secret_token"
GITLAB_ACCESS_TOKEN="glpat-xxxxxxxxxxxxxxxxxxxx"
GITLAB_BASE_URL="https://gitlab.com"  # or your self-hosted URL
```

### 4. Database Setup

```bash
npx prisma generate
npx prisma db push
```

### 5. Run

```bash
npm run dev
```

For webhook forwarding (GitHub local dev):
```bash
npx smee-client -U https://smee.io/YOUR_URL -t http://localhost:3000/api/webhooks
```

---

## 🔌 Platform Setup

### GitHub Setup

1. Create a [GitHub App](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/creating-a-github-app)
2. Set webhook URL to `https://your-domain.com/api/webhooks`
3. Subscribe to events: **Pull requests**, **Issue comments**
4. Permissions: Read & Write on Pull requests, Issues, Contents
5. Install the app on your repositories

### GitLab Setup

1. Go to your **GitLab Project → Settings → Webhooks**
2. Set URL to `https://your-domain.com/api/gitlab/webhooks`
3. Set **Secret token** to your `GITLAB_WEBHOOK_SECRET` value
4. Check **Merge request events** trigger
5. Enable SSL verification
6. Create a **Project Access Token** (or Personal Access Token) with:
   - `api` scope (for posting notes and managing labels)
   - Set as `GITLAB_ACCESS_TOKEN` in your `.env`
7. For **self-hosted** GitLab, set `GITLAB_BASE_URL` to your instance URL

#### GitLab Event Flow

```
MR opened/updated → Webhook → POST /api/gitlab/webhooks
                              → Validates X-Gitlab-Token
                              → Enqueues BullMQ job
                              → Worker fetches diff via GitLab API
                              → LLM review
                              → Posts summary note + inline discussions
                              → Applies labels
```

---

## 🤖 Slash Commands (GitHub Only)

Comment on any PR to trigger:

| Command | Description |
|---|---|
| `@reviewcodebot /review` | Trigger a fresh re-review of the PR |
| `@reviewcodebot /help` | Show available commands |

Rate limiting: max 3 manual reviews per PR per hour.

---

## ⚙️ Per-Repo Configuration

Drop a `.reviewcodereview.yml` in your repo root:

```yaml
ignore_paths:
  - "*.lock"
  - "dist/**"
  - "*.generated.ts"

review_focus:
  - security
  - performance
  - logic
  - bugs

severity_threshold: "low"     # low | medium | high | critical
auto_approve_if_clean: false

custom_rules:
  - "Always check for SQL injection in raw queries"
  - "Ensure all async functions have try/catch"
```

---

## 📊 Dashboard

Run the Next.js dashboard:

```bash
cd dashboard
npm install
npm run dev -- -p 3001
```

Open `http://localhost:3001` to see:
- **Stats cards**: PRs reviewed, bugs caught, critical issues, repos connected
- **Activity chart**: 14-day review histogram
- **Recent reviews table**: Latest reviews with verdict badges

---

## 🎬 GitHub Action (Detailed)

### All Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `github-token` | ✅ | — | GitHub token for API access |
| `anthropic-api-key` | ✅ | — | Anthropic API key for Claude |
| `model` | ❌ | `claude-sonnet-4-20250514` | Claude model to use |
| `severity-threshold` | ❌ | `medium` | Minimum severity: `critical`, `high`, `medium`, `low` |
| `ignore-paths` | ❌ | `*.lock,dist/**` | Comma-separated glob patterns to ignore |
| `fail-on-critical` | ❌ | `true` | Exit 1 if critical issues found (blocks merge) |
| `max-files` | ❌ | `30` | Maximum files to review |
| `custom-rules` | ❌ | — | Comma-separated review rules |

### Outputs

| Output | Description |
|---|---|
| `verdict` | `approve`, `request_changes`, or `comment` |
| `issue-count` | Total issues found |
| `critical-count` | Critical severity issues |
| `high-count` | High severity issues |

### Advanced Usage

```yaml
- uses: KartikeyaNainkhwal/reviewbot@v1
  id: review
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
    severity-threshold: 'high'
    ignore-paths: '*.lock,dist/**,docs/**'
    fail-on-critical: 'true'
    custom-rules: 'Check for SQL injection,Ensure error handling'

- name: Check verdict
  run: |
    echo "Verdict: ${{ steps.review.outputs.verdict }}"
    echo "Issues: ${{ steps.review.outputs.issue-count }}"
    echo "Critical: ${{ steps.review.outputs.critical-count }}"
```

### Block Merge on Critical Issues

With `fail-on-critical: 'true'` (default), the action exits with code 1 when critical issues are found. Add it as a **required status check** in your branch protection rules to block merges.

### Building the Action Bundle

```bash
npm run build:action    # Bundles src/action.ts → dist/action.js (single file)
npm run release         # Build + commit + tag v1
```

---

## 🧪 Testing

```bash
npm test
```

To test the bot, create a branch with a deliberate bug (SQL injection, infinite loop) and open a Pull Request. ReviewCode will review it within seconds.

---

## 🪪 License

Distributed under the MIT License. See `LICENSE` for more information.

<div align="center">
  <i>Built with ❤️ by Kartikeya Nainkhwal</i>
</div>
