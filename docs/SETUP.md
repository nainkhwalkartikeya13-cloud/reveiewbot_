# Setup Guide

## Prerequisites

- **Node.js 20+** — [Download](https://nodejs.org)
- **Docker & Docker Compose** — [Install Docker](https://docs.docker.com/get-docker/)
- **GitHub Account** with org admin access (to create a GitHub App)
- **Anthropic API Key** — [Get one](https://console.anthropic.com/)

## Step 1: Create a GitHub App

1. Go to [GitHub Developer Settings → GitHub Apps → New GitHub App](https://github.com/settings/apps/new)

2. Fill in:
   - **GitHub App name**: `ReviewCode Code Review` (or your choice)
   - **Homepage URL**: `https://github.com/KartikeyaNainkhwal/reviewcode`
   - **Webhook URL**: Your server URL + `/api/webhooks` (e.g., `https://your-domain.com/api/webhooks`)
     - For local dev, use [smee.io](https://smee.io) or [ngrok](https://ngrok.com) to tunnel
   - **Webhook secret**: Generate a strong secret (e.g., `openssl rand -hex 32`)

3. **Permissions** — set these:
   | Permission | Access |
   |-----------|--------|
   | Pull requests | Read & Write |
   | Contents | Read-only |
   | Metadata | Read-only |
   | Issues | Read & Write |

4. **Subscribe to events**:
   - ✅ Pull request
   - ✅ Installation
   - ✅ Issue comment (for feedback)

5. Click **Create GitHub App**

6. After creation:
   - Note the **App ID** (shown at top of settings page)
   - Generate a **Private Key** (scroll down, click "Generate a private key")
   - Save the downloaded `.pem` file
   - Note the **Client ID** and generate a **Client Secret** (under "Optional features")

## Step 2: Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# From Step 1
GITHUB_APP_ID=<your-app-id>
GITHUB_APP_PRIVATE_KEY="$(cat path/to/your-app.pem)"
GITHUB_WEBHOOK_SECRET=<your-webhook-secret>

# From Anthropic Console
ANTHROPIC_API_KEY=sk-ant-...

# Leave defaults for local dev
DATABASE_URL=postgresql://reviewcode:axd_dev@localhost:5432/reviewcode?schema=public
REDIS_URL=redis://localhost:6379
```

> **Tip:** For `GITHUB_APP_PRIVATE_KEY`, you can either paste the PEM contents (replacing newlines with `\n`) or use the file directly.

## Step 3: Start Infrastructure

```bash
# Start Postgres + Redis
npm run docker:dev
```

This starts:
- PostgreSQL on port `5432`
- Redis on port `6379`

## Step 4: Set Up Database

```bash
# Generate Prisma client
npm run prisma:generate

# Run migrations
npm run prisma:migrate

# (Optional) View database in browser
npm run prisma:studio
```

## Step 5: Start the Server

```bash
npm run dev
```

You should see:
```
🚀 ReviewCode server started { port: 3000, env: 'development' }
Review worker started { concurrency: 3 }
```

## Step 6: Install the App on a Repository

1. Go to your GitHub App's settings page
2. Click **Install App** in the sidebar
3. Choose an organization or your personal account
4. Select specific repositories (recommended) or all repositories
5. Click **Install**

## Step 7: Test It

1. Create a PR in one of the installed repositories
2. Watch the server logs — you should see the webhook received and a review job enqueued
3. After a few seconds, the bot will post a review with inline comments

## Local Development with Webhook Tunneling

For local development, GitHub can't reach `localhost`. Use one of:

### Option A: smee.io (easiest)
```bash
npm install -g smee-client
smee -u https://smee.io/your-channel -t http://localhost:3000/api/webhooks
```
Set the smee URL as your app's Webhook URL.

### Option B: ngrok
```bash
ngrok http 3000
```
Use the ngrok HTTPS URL as your app's Webhook URL.

## Production Deployment

```bash
# Build production image
docker build -f docker/Dockerfile -t reviewcode .

# Or use Docker Compose for full stack
docker compose -f docker/docker-compose.yml up -d
```

Ensure all production env vars are set (especially `NODE_ENV=production`).
