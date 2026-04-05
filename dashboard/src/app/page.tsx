"use client";

import { useEffect, useState, useCallback } from "react";
import { ActivityChart } from "@/components/activity-chart";

// ─── Types ──────────────────────────────────────────────────────────────

interface Stats {
  totalReviews: number;
  totalIssues: number;
  criticalCount: number;
  highCount: number;
  connectedRepos: number;
  approvalRate: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalEstimatedCost: number;
  activity: { date: string; reviews: number }[];
}

interface Review {
  id: string;
  repo: string;
  prNumber: number;
  verdict: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" | null;
  issueCount: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  filesReviewed: number;
  durationMs: number;
  headSha: string;
  triggeredBy: string;
  summary: string | null;
  createdAt: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining}s`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ─── Verdict Badge ──────────────────────────────────────────────────────

function VerdictBadge({ verdict }: { verdict: Review["verdict"] }) {
  if (!verdict) return <span className="badge badge-comment">Pending</span>;
  const map = {
    APPROVE: { cls: "badge-approve", icon: "✅", text: "Approved" },
    REQUEST_CHANGES: {
      cls: "badge-request-changes",
      icon: "🔴",
      text: "Changes",
    },
    COMMENT: { cls: "badge-comment", icon: "💬", text: "Commented" },
  };
  const cfg = map[verdict];
  return (
    <span className={`badge ${cfg.cls}`}>
      {cfg.icon} {cfg.text}
    </span>
  );
}

// ─── Stat Card ──────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  icon,
  subtext,
  delay,
}: {
  label: string;
  value: string | number;
  icon: string;
  subtext?: string;
  delay: number;
}) {
  return (
    <div
      className="glass-card stat-card p-6 animate-in"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-start justify-between">
        <div>
          <p className="text-foreground-dim text-sm font-medium mb-1">
            {label}
          </p>
          <p className="text-3xl font-bold tracking-tight text-foreground">
            {typeof value === "number" ? formatNumber(value) : value}
          </p>
          {subtext && (
            <p className="text-foreground-dim text-xs mt-2">{subtext}</p>
          )}
        </div>
        <div className="text-3xl opacity-80">{icon}</div>
      </div>
    </div>
  );
}

// ─── Skeleton Loaders ───────────────────────────────────────────────────

function StatSkeleton() {
  return (
    <div className="glass-card p-6">
      <div className="skeleton h-4 w-24 mb-3" />
      <div className="skeleton h-8 w-20 mb-2" />
      <div className="skeleton h-3 w-32" />
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-3">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="skeleton h-12 w-full" />
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// Main Dashboard
// ═══════════════════════════════════════════════════════════════════════

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [loading, setLoading] = useState(true);

  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const [statsRes, reviewsRes] = await Promise.all([
        fetch("/api/stats"),
        fetch("/api/reviews"),
      ]);

      if (statsRes.status === 401 || reviewsRes.status === 401) {
        setError("Please sign in with GitHub to view your repositories.");
        setLoading(false);
        return;
      }

      const statsData = await statsRes.json();
      const reviewsData = await reviewsRes.json();
      setStats(statsData);
      setReviews(reviewsData);
      setLastRefresh(new Date());
      setError(null);
    } catch (err) {
      console.error("Failed to fetch dashboard data:", err);
      setError("Failed to fetch data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 30_000);
    return () => clearInterval(interval);
  }, [fetchData]);

  return (
    <div className="min-h-screen bg-background">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl sm:text-3xl font-bold text-foreground flex items-center gap-3">
                <span className="text-4xl">🤖</span>
                ReviewCode
              </h1>
              <p className="text-foreground-dim text-sm mt-1">
                AI-powered code review intelligence
              </p>
            </div>
            <div className="flex items-center gap-3 text-foreground-dim text-sm">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500 pulse-dot inline-block" />
                <span className="hidden sm:inline">Live</span>
              </div>
              <span className="hidden sm:inline text-foreground-dim/50">·</span>
              <span className="hidden sm:inline">
                Updated {timeAgo(lastRefresh.toISOString())}
              </span>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
        {error ? (
          <div className="glass-card p-16 text-center animate-in">
            <p className="text-5xl mb-4">🔒</p>
            <h2 className="text-2xl font-bold text-foreground mb-2">Access Restricted</h2>
            <p className="text-foreground-dim">{error}</p>
          </div>
        ) : (
          <>
            {/* ── Stats Cards ──────────────────────────────────────────── */}
            <section>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                {loading ? (
                  <>
                    <StatSkeleton />
                    <StatSkeleton />
                    <StatSkeleton />
                    <StatSkeleton />
                  </>
                ) : stats ? (
                  <>
                    <StatCard
                      label="PRs Reviewed"
                      value={stats.totalReviews}
                      icon="📋"
                      subtext={`${stats.approvalRate}% approval rate`}
                      delay={0}
                    />
                    <StatCard
                      label="Bugs Caught"
                      value={stats.totalIssues}
                      icon="🐛"
                      subtext={`${stats.highCount} high severity`}
                      delay={80}
                    />
                    <StatCard
                      label="Critical Issues"
                      value={stats.criticalCount}
                      icon="🔴"
                      subtext="Requires immediate attention"
                      delay={160}
                    />
                    <StatCard
                      label="Repos Connected"
                      value={stats.connectedRepos}
                      icon="📦"
                      subtext={`${formatNumber(stats.totalPromptTokens + stats.totalCompletionTokens)} tokens • $${stats.totalEstimatedCost.toFixed(2)}`}
                      delay={240}
                    />
                  </>
                ) : null}
              </div>
            </section>

            {/* ── Activity Chart ───────────────────────────────────────── */}
            <section className="glass-card p-6 animate-in" style={{ animationDelay: "300ms" }}>
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">
                    Review Activity
                  </h2>
                  <p className="text-foreground-dim text-sm">
                    PRs reviewed per day — last 14 days
                  </p>
                </div>
              </div>
              {loading ? (
                <div className="skeleton h-[240px] w-full" />
              ) : stats?.activity ? (
                <ActivityChart data={stats.activity} />
              ) : (
                <div className="h-[240px] flex items-center justify-center text-foreground-dim">
                  No activity data
                </div>
              )}
            </section>

            {/* ── Recent Reviews Table ─────────────────────────────────── */}
            <section className="glass-card p-6 animate-in" style={{ animationDelay: "400ms" }}>
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h2 className="text-lg font-semibold text-foreground">
                    Recent Reviews
                  </h2>
                  <p className="text-foreground-dim text-sm">
                    Latest 20 completed reviews
                  </p>
                </div>
                {reviews && (
                  <span className="text-foreground-dim text-sm">
                    {reviews.length} review{reviews.length !== 1 && "s"}
                  </span>
                )}
              </div>

              {loading ? (
                <TableSkeleton />
              ) : reviews && reviews.length > 0 ? (
                <div className="overflow-x-auto -mx-6">
                  <table className="w-full min-w-[700px]">
                    <thead>
                      <tr className="border-b border-border text-left">
                        <th className="px-6 py-3 text-xs font-semibold text-foreground-dim uppercase tracking-wider">
                          Repository
                        </th>
                        <th className="px-4 py-3 text-xs font-semibold text-foreground-dim uppercase tracking-wider">
                          PR
                        </th>
                        <th className="px-4 py-3 text-xs font-semibold text-foreground-dim uppercase tracking-wider">
                          Verdict
                        </th>
                        <th className="px-4 py-3 text-xs font-semibold text-foreground-dim uppercase tracking-wider text-center">
                          Issues
                        </th>
                        <th className="px-4 py-3 text-xs font-semibold text-foreground-dim uppercase tracking-wider text-center">
                          Critical
                        </th>
                        <th className="px-4 py-3 text-xs font-semibold text-foreground-dim uppercase tracking-wider text-right">
                          Duration
                        </th>
                        <th className="px-6 py-3 text-xs font-semibold text-foreground-dim uppercase tracking-wider text-right">
                          When
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {reviews.map((r) => (
                        <tr
                          key={r.id}
                          className="table-row group hover:bg-white/[0.03] transition-colors cursor-pointer"
                          onClick={() => window.open(`https://github.com/${r.repo}/pull/${r.prNumber}`, '_blank')}
                        >
                          <td className="px-6 py-4">
                            <div className="flex items-center justify-between w-full">
                              <a
                                href={`https://github.com/${r.repo}`}
                                target="_blank"
                                onClick={(e) => e.stopPropagation()}
                                className="text-accent font-medium text-sm font-mono truncate max-w-[200px]"
                              >
                                {r.repo}
                              </a>
                            </div>
                          </td>
                          <td className="px-4 py-4">
                            <a
                              href={`https://github.com/${r.repo}/pull/${r.prNumber}`}
                              target="_blank"
                              onClick={(e) => e.stopPropagation()}
                              className="text-foreground-muted font-mono text-sm group-hover:text-white transition-colors"
                            >
                              #{r.prNumber} ↗
                            </a>
                          </td>
                          <td className="px-4 py-4">
                            <VerdictBadge verdict={r.verdict} />
                          </td>
                          <td className="px-4 py-4 text-center">
                            <span
                              className={`font-semibold text-sm ${r.issueCount > 0
                                ? "text-foreground"
                                : "text-foreground-dim"
                                }`}
                            >
                              {r.issueCount}
                            </span>
                          </td>
                          <td className="px-4 py-4 text-center">
                            <span
                              className={`font-semibold text-sm ${r.criticalCount > 0
                                ? "text-[var(--critical)]"
                                : "text-foreground-dim"
                                }`}
                            >
                              {r.criticalCount}
                            </span>
                          </td>
                          <td className="px-4 py-4 text-right">
                            <span className="text-foreground-dim text-sm font-mono">
                              {formatDuration(r.durationMs)}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-right">
                            <span className="text-foreground-dim text-sm">
                              {timeAgo(r.createdAt)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="text-center py-16">
                  <p className="text-5xl mb-4">🔍</p>
                  <p className="text-foreground-muted text-lg font-medium">
                    No reviews yet
                  </p>
                  <p className="text-foreground-dim text-sm mt-1">
                    Reviews will appear here once the bot starts reviewing PRs
                  </p>
                </div>
              )}
            </section>
          </>
        )}
      </main>

      {/* ── Footer ─────────────────────────────────────────────────── */}
      <footer className="border-t border-border mt-8">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 flex items-center justify-between text-foreground-dim text-xs">
          <span>🤖 ReviewCode · AI-powered code review</span>
          <span>Auto-refreshes every 30s</span>
        </div>
      </footer>
    </div>
  );
}
