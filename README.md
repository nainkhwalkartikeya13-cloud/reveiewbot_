<div align="center">
  <img src="https://assets.vercel.com/image/upload/v1607554385/repositories/next-js/next-logo.png" width="100" height="auto" />
  <h1>🤖 ReviewCode</h1>
  <p><b>An enterprise-grade, multi-tenant AI Code Reviewer for GitHub & GitLab.</b></p>
  
  <p>
    <a href="https://github.com/KartikeyaNainkhwal/reviewbot/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/KartikeyaNainkhwal/reviewbot/release.yml?style=for-the-badge&logo=github&color=3b82f6" alt="CI Status" /></a>
    <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" /></a>
    <a href="https://nextjs.org/"><img src="https://img.shields.io/badge/Next.js_16-000000?style=for-the-badge&logo=next.js&logoColor=white" alt="Next.js" /></a>
    <a href="https://supabase.com/"><img src="https://img.shields.io/badge/Supabase-3ECF8E?style=for-the-badge&logo=supabase&logoColor=white" alt="Supabase" /></a>
    <a href="https://upstash.com/"><img src="https://img.shields.io/badge/Upstash_Redis-00E676?style=for-the-badge&logo=redis&logoColor=white" alt="Redis" /></a>
    <a href="https://vercel.com/"><img src="https://img.shields.io/badge/Vercel-000000?style=for-the-badge&logo=vercel&logoColor=white" alt="Vercel" /></a>
  </p>

  <p>
    <i>Stop waiting hours for a human to review your Pull Requests. Let Artificial Intelligence parse your Git Diffs, catch critical bugs, and suggest one-click fixes instantly.</i>
  </p>
</div>

<br />

---

## ⚡ Overview

**ReviewCode** acts as an automated Senior Developer on your team. It connects as a **GitHub App** and listens to `pull_request` webhooks, instantaneously pulling down the `git diff`, parsing the newly modified lines, and executing an intelligent review using the **Llama-3 70B** architecture.

Unlike simple bots, ReviewCode operates on a highly scalable queue system (`BullMQ` + `Upstash Redis`), ensuring zero missed reviews during massive deployment traffic.

ReviewCode also ships with a **Next.js 16 Multi-Tenant Dashboard** allowing users to securely authenticate via GitHub OAuth, managing exclusively their own repositories and metrics.

<br />

## ✨ The ReviewCode Advantage

<details open>
<summary><b>🔥 Key Features</b></summary>
<br>

| Feature | Capability |
| :--- | :--- |
| 🧠 **AI-Powered Analysis** | Instantly catches complex logic flaws, SQL injections, and performance bottlenecks. |
| 🔒 **Multi-Tenant Dashboard** | Users authenticate via GitHub NextAuth to securely view their specific metrics. |
| ⚡ **Diff-Based Reviews** | Analyzes only newly modified code. Saves LLM tokens and prevents overwhelming noise. |
| 🔄 **Async Architecture** | Handles massive traffic with `BullMQ` and Serverless `Upstash Redis`. |
| 🏷️ **Intelligent Labeling** | Applies dynamic severity tags (`reviewcode: critical`, `reviewcode: approved`). |
| 💡 **One-Click Fixes** | Posts inline code suggestions natively in the GitHub UI for one-click application. |
| 🤖 **Slash Commands** | Type `@reviewcodebot /review` anywhere in the PR to force a re-run. |

</details>

<br />

## 🏛️ Full-Stack Architecture

ReviewCode is split into two primary components: The **Worker Engine** and the **SaaS Dashboard**. 

```mermaid
graph TD
    A[Developer Pushes PR] -->|Webhook| B(GitHub App Server)
    B -->|Enqueues Job| C{Redis Queue / BullMQ}
    C -->|Pulls Job| D[Node.js Worker]
    D -->|Fetches Diff| E[GitHub API]
    D -->|Executes LLM Prompt| F[Groq / Llama 3]
    F -->|Returns Code Fixes| D
    D -->|Creates Comments| E
    D -->|Persists Analytics| G[(Supabase / PostgreSQL)]
    H[SaaS User] -->|OAuth Login| I(Next.js 16 Dashboard)
    I -->|Reads Metrics| G
```

<br />

---

## 🚀 Deployment Guide

ReviewCode is production-ready. We highly recommend deploying the Worker to **Railway** and the Dashboard to **Vercel**.

### 1. Database & Queue (Supabase & Upstash)
- Spin up a free **PostgreSQL** database on [Supabase](https://supabase.com).
- Spin up a Serverless **Redis** instance on [Upstash](https://upstash.com).

### 2. The Worker Engine (Railway / Docker)
Clone the repository and deploy the root directory. 
Require the following Environment Variables:

```env
DATABASE_URL="postgresql://postgres:password@pooler.supabase.com:6543/postgres"
REDIS_URL="rediss://default:password@upstash.io:6379"

GITHUB_APP_ID="your_app_id"
GITHUB_WEBHOOK_SECRET="your_webhook_secret"
GITHUB_CLIENT_ID="for_oauth"
GITHUB_CLIENT_SECRET="for_oauth"
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"

LLM_PROVIDER="groq"
GROQ_API_KEY="gsk_..."
```

### 3. The Multi-Tenant Dashboard (Vercel)
Deploy the `/dashboard` directory to Vercel. Vercel automatically runs `npx prisma generate` during the build phase.

```env
DATABASE_URL="postgresql://postgres:password@pooler.supabase.com:6543/postgres"
GITHUB_CLIENT_ID="for_oauth"
GITHUB_CLIENT_SECRET="for_oauth"
AUTH_SECRET="a_secure_random_string"
```

> **Note:** Set the **Root Directory** in Vercel to `dashboard`.

<br />

## ⚙️ Custom Configurations (.reviewcode.yml)

Users can heavily customize the bot on a per-repository basis by adding a `.reviewcode.yml` file to the root of their code:

```yaml
ignore_paths:
  - "dist/**"
  - "*.config.js"

review_focus:
  - security
  - performance

severity_threshold: "medium" 
auto_approve_if_clean: true

custom_rules:
  - "Always reject raw SQL queries."
  - "Force the use of React Server Components where possible."
```

<br />

---

<div align="center">
  <h3>Built for modern engineering teams.</h3>
  <p>Designed and engineered by <a href="https://github.com/KartikeyaNainkhwal">Kartikeya Nainkhwal</a>.</p>
</div>
