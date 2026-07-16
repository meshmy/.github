#!/usr/bin/env node
// Regenerates the org activity chart + top-repo tables in profile/README.md
// from live GitHub data. No npm dependencies — run directly with `node`.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ORG = process.env.GH_ORG || "meshmy";
const TOKEN = process.env.GITHUB_TOKEN;
const API = "https://api.github.com";
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const WEEKS = 52;
const MAX_COMMIT_PAGES = 5; // per repo cap, keeps API usage bounded

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");
const PROFILE_DIR = path.join(ROOT, "profile");

async function ghFetch(pathname) {
  const res = await fetch(`${API}${pathname}`, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${pathname}: ${await res.text()}`);
  }
  return res;
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.split(",").find((part) => part.includes('rel="next"'));
  if (!match) return null;
  return match.split(";")[0].trim().replace(/^<|>$/g, "");
}

async function ghPaginate(pathname) {
  const results = [];
  let url = `${pathname}${pathname.includes("?") ? "&" : "?"}per_page=100`;
  let count = 0;
  while (url && count < 20) {
    const res = await ghFetch(url.replace(API, ""));
    results.push(...(await res.json()));
    url = parseNextLink(res.headers.get("link"));
    count += 1;
  }
  return results;
}

async function fetchOrgRepos() {
  const repos = await ghPaginate(`/orgs/${ORG}/repos?type=public`);
  return repos.filter((r) => !r.archived);
}

async function fetchOrgMembers() {
  const members = await ghPaginate(`/orgs/${ORG}/members`);
  return new Set(members.map((m) => m.login));
}

// For one repo: walk commits (newest first) and collect the ones authored
// by an org member, up to MAX_COMMIT_PAGES pages, since 1 year ago.
async function fetchOrgAuthoredCommits(repoName, memberLogins, sinceISO) {
  const commits = [];
  let url = `/repos/${ORG}/${repoName}/commits?since=${sinceISO}&per_page=100`;
  let page = 0;
  while (url && page < MAX_COMMIT_PAGES) {
    let res;
    try {
      res = await ghFetch(url.replace(API, ""));
    } catch {
      break; // empty repo / no commit history / disabled — treat as no activity
    }
    const batch = await res.json();
    for (const c of batch) {
      const login = c.author?.login;
      if (login && memberLogins.has(login)) {
        commits.push(c.commit.author.date);
      }
    }
    url = parseNextLink(res.headers.get("link"));
    page += 1;
  }
  return commits;
}

function engagementScore(repo) {
  return (
    (repo.stargazers_count || 0) +
    (repo.forks_count || 0) +
    (repo.watchers_count || 0) +
    (repo.open_issues_count || 0)
  );
}

function bucketWeekly(allDates, now) {
  const buckets = new Array(WEEKS).fill(0);
  for (const iso of allDates) {
    const ageMs = now - new Date(iso).getTime();
    const weekIdx = Math.floor(ageMs / (7 * 24 * 60 * 60 * 1000));
    if (weekIdx >= 0 && weekIdx < WEEKS) {
      buckets[weekIdx] += 1;
    }
  }
  return buckets.reverse(); // oldest -> newest, left to right
}

const THEMES = {
  dark: { bg: "#0d1117", border: "#30363d", text: "#c9d1d9", subtext: "#8b949e", bar: "#58a6ff", grid: "#21262d" },
  light: { bg: "#ffffff", border: "#d0d7de", text: "#24292f", subtext: "#57606a", bar: "#0969da", grid: "#eaeef2" },
};

function renderChartSVG(themeName, weeklyCounts, totalCommits) {
  const theme = THEMES[themeName];
  const width = 760;
  const height = 260;
  const padding = { top: 56, right: 24, bottom: 36, left: 24 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;
  const maxCount = Math.max(1, ...weeklyCounts);
  const barGap = 2;
  const barW = chartW / WEEKS - barGap;

  const now = new Date();
  const bars = weeklyCounts
    .map((count, i) => {
      const barH = count === 0 ? 2 : Math.max(4, (count / maxCount) * chartH);
      const x = padding.left + i * (chartW / WEEKS);
      const y = padding.top + chartH - barH;
      const weeksAgo = WEEKS - 1 - i;
      const weekDate = new Date(now.getTime() - weeksAgo * 7 * 24 * 60 * 60 * 1000);
      const title = `${weekDate.toISOString().slice(0, 10)}: ${count} commit${count === 1 ? "" : "s"}`;
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH.toFixed(1)}" rx="1.5" fill="${theme.bar}" fill-opacity="${count === 0 ? 0.25 : 0.9}"><title>${title}</title></rect>`;
    })
    .join("");

  // Month tick labels every ~4 weeks, skipping immediate repeats of the same month
  const ticks = [];
  let lastLabel = null;
  for (let i = 0; i < WEEKS; i += 4) {
    const weeksAgo = WEEKS - 1 - i;
    const weekDate = new Date(now.getTime() - weeksAgo * 7 * 24 * 60 * 60 * 1000);
    const x = padding.left + i * (chartW / WEEKS);
    const label = weekDate.toLocaleString("en-US", { month: "short" });
    if (label === lastLabel) continue;
    lastLabel = label;
    ticks.push(
      `<text x="${x.toFixed(1)}" y="${height - 12}" font-size="11" fill="${theme.subtext}" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">${label}</text>`
    );
  }

  const baselineY = padding.top + chartH;

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="meshmy organization commit activity, last 52 weeks">
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="${theme.bg}" stroke="${theme.border}" />
  <text x="24" y="34" font-size="16" font-weight="600" fill="${theme.text}" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">meshmy Organization Activity</text>
  <text x="24" y="52" font-size="12" fill="${theme.subtext}" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">${totalCommits} commits by org members in the last ${WEEKS} weeks</text>
  <line x1="${padding.left}" y1="${baselineY}" x2="${width - padding.right}" y2="${baselineY}" stroke="${theme.grid}" stroke-width="1" />
  ${bars}
  ${ticks.join("\n  ")}
</svg>
`;
}

function escapeHtml(str) {
  return (str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function formatDate(isoOrDate) {
  return new Date(isoOrDate).toISOString().slice(0, 10);
}

function renderRepoList(repos, metricLabel, metricFn) {
  const items = repos
    .map((repo) => {
      const desc = repo.description ? escapeHtml(repo.description) : "<i>no description</i>";
      return `<li><a href="${repo.html_url}"><b>${escapeHtml(repo.name)}</b></a><br /><sub>${desc}</sub><br /><sub>${metricLabel}: ${metricFn(repo)}</sub></li>`;
    })
    .join("\n        ");
  return `      <ol>\n        ${items}\n      </ol>`;
}

function renderRepoTable(recentRepos, topRepos) {
  return `<table>
  <tr>
    <td valign="top" width="50%">
      <h3>🕒 Recently Active</h3>
${renderRepoList(recentRepos, "last org activity", (r) => formatDate(r._lastOrgActivity))}
    </td>
    <td valign="top" width="50%">
      <h3>🔥 Top by Engagement</h3>
${renderRepoList(topRepos, "engagement score", (r) => r._engagement)}
    </td>
  </tr>
</table>`;
}

function injectSection(content, marker, body) {
  const start = `<!-- ${marker}:START -->`;
  const end = `<!-- ${marker}:END -->`;
  const startIdx = content.indexOf(start);
  const endIdx = content.indexOf(end);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(`Missing ${marker} markers in profile/README.md`);
  }
  return content.slice(0, startIdx + start.length) + "\n" + body + "\n" + content.slice(endIdx);
}

async function main() {
  const now = Date.now();
  const sinceISO = new Date(now - YEAR_MS).toISOString();

  const [repos, memberLogins] = await Promise.all([fetchOrgRepos(), fetchOrgMembers()]);

  const allOrgCommitDates = [];
  for (const repo of repos) {
    const dates = await fetchOrgAuthoredCommits(repo.name, memberLogins, sinceISO);
    allOrgCommitDates.push(...dates);
    repo._lastOrgActivity = dates.length > 0 ? dates.reduce((a, b) => (a > b ? a : b)) : repo.created_at;
    repo._engagement = engagementScore(repo);
  }

  const recentRepos = [...repos]
    .sort((a, b) => new Date(b._lastOrgActivity) - new Date(a._lastOrgActivity))
    .slice(0, 5);
  const topRepos = [...repos].sort((a, b) => b._engagement - a._engagement).slice(0, 5);

  const weeklyCounts = bucketWeekly(allOrgCommitDates, now);
  const totalCommits = allOrgCommitDates.length;

  await writeFile(path.join(PROFILE_DIR, "activity-graph-dark.svg"), renderChartSVG("dark", weeklyCounts, totalCommits));
  await writeFile(path.join(PROFILE_DIR, "activity-graph-light.svg"), renderChartSVG("light", weeklyCounts, totalCommits));

  const readmePath = path.join(PROFILE_DIR, "README.md");
  let readme = await readFile(readmePath, "utf8");
  readme = injectSection(readme, "REPOS", renderRepoTable(recentRepos, topRepos));
  await writeFile(readmePath, readme);

  console.log(`Updated profile for ${repos.length} repos, ${totalCommits} org-authored commits in last ${WEEKS} weeks.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
