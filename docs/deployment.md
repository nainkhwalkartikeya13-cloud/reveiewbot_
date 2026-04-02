# AXD Production Deployment Guide

Deploying AXD requires moving away from local Docker containers for Redis and PostgreSQL to managed cloud services for reliability, scaling, and backups.

This guide outlines the quickest path to production using **Railway** (for hosting the app and Redis) and **Supabase** (for PostgreSQL).

## 1. Database Setup (Supabase)

Supabase offers a generous free tier for managed PostgreSQL.

1. Create a new project on [Supabase](https://supabase.com).
2. Go to **Project Settings -> Database**.
3. Locate the **Connection string** (URI). It will look like:
   `postgresql://postgres.[YOUR_PROJECT]:[YOUR_PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true`
4. Store this URL.

### Migrate the Schema

From your local machine, run Prisma migrations against the new database:

```bash
DATABASE_URL="your-supabase-url" npx prisma db push
```

*(Note: In production, it's better to use `npx prisma migrate deploy` if you have migration history).*

## 2. Queue Setup (Upstash / Railway Redis)

You need a managed Redis instance for BullMQ. 

- **Option A (Railway)**: If you use Railway to host the backend, you can provision a Redis database directly in the Railway project.
- **Option B (Upstash)**: [Upstash](https://upstash.com/) offers Serverless Redis. Create a database, copy the connecting string (`redis://default:password@endpoint.upstash.io:30489`).

## 3. Backend Deployment (Railway)

[Railway](https://railway.app/) is perfect for Node.js Express worker apps.

1. Connect your GitHub repository to Railway.
2. Railway will automatically detect the Node.js environment via `package.json`.
3. Add the following **Environment Variables** to the Railway service:

```env
NODE_ENV=production
PORT=3000

# Infra
DATABASE_URL="postgresql://postgres.[project]:[password]@aws.pooler.supabase.com:6543/postgres"
REDIS_URL="redis://default:password@endpoint.upstash.io:30489"

# GitHub Auth
GITHUB_APP_ID="your_app_id"
GITHUB_WEBHOOK_SECRET="your_webhook_secret"
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"

# LLM Providers
ANTHROPIC_API_KEY="sk-ant-..."
GROQ_API_KEY="gsk_..."
```

4. Tell Railway how to build and start the app (you can define these in `package.json` or Railway settings):
   - **Build Command:** `npm run build`
   - **Start Command:** `npm start` *(which should map to `node dist/index.js`)*

## 4. Webhook Re-Routing

Locally, you used `smee.io` to proxy webhooks. In production:

1. Copy your Railway app's public URL (e.g., `https://axd-production.up.railway.app`).
2. Go to your **GitHub App Settings** -> **General**.
3. Update the **Webhook URL** to: `https://axd-production.up.railway.app/api/webhooks`.
4. Update the webhook URL in **GitLab** to `.../api/gitlab/webhooks`.

## 5. Dashboard Deployment (Vercel)

The Next.js dashboard (`/dashboard`) is best hosted on Vercel.

1. Import the project into Vercel.
2. Set the **Root Directory** to `dashboard/`.
3. Add the identical `DATABASE_URL` environment variable to Vercel (the dashboard reads directly from the database).
4. Deploy!

---

### Production Checklist

- [ ] **Prisma Pooling**: Ensure `connection_limit=10` is added to your Prisma connection string if not using Supabase's built-in PgBouncer pooler.
- [ ] **Logs**: Configure Railway to stream logs (or use a tool like Datadog/Sentry).
- [ ] **Token Usage Cost**: The dashboard now estimates your Grok/Claude LLM costs based on the `UsageRecord` table. Monitor this weekly.
- [ ] **Rate Limiting**: The `MAX_REVIEWS_PER_HOUR_PER_INSTALL` env var (default: 30) protects you from runaway webhook spam. Adjust as necessary if your team is large.
