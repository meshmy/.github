#!/usr/bin/env node
// Regenerates the org activity chart + top-repo tables in profile/README.md
// from live GitHub data. No npm dependencies — run directly with `node`.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ORG = process.env.GH_ORG || "meshmy";
const TOKEN = process.env.GITHUB_TOKEN;
const API = "https://api.github.com";
const DAY_MS = 24 * 60 * 60 * 1000;
const GRID_WEEKS = 53;
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

// Builds a GitHub-style contribution grid: gridStart is the Sunday that
// begins the oldest full week, so day index i (0 = gridStart) always maps
// to column i/7, row i%7 with row 0 = Sunday.
function buildGrid(allDates) {
  const today = new Date();
  const endDate = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const dow = endDate.getUTCDay(); // 0 = Sunday
  const gridStart = new Date(endDate.getTime() - (GRID_WEEKS - 1) * 7 * DAY_MS - dow * DAY_MS);
  const totalDays = Math.round((endDate.getTime() - gridStart.getTime()) / DAY_MS) + 1;

  const counts = new Array(totalDays).fill(0);
  for (const iso of allDates) {
    const dayIdx = Math.floor((new Date(iso).getTime() - gridStart.getTime()) / DAY_MS);
    if (dayIdx >= 0 && dayIdx < totalDays) counts[dayIdx] += 1;
  }

  return { gridStart, totalDays, counts };
}

const THEMES = {
  dark: {
    bg: "#0d1117",
    border: "#30363d",
    text: "#c9d1d9",
    subtext: "#8b949e",
    levels: ["#161b22", "#123661", "#1a4f8c", "#2a72c4", "#58a6ff"],
  },
  light: {
    bg: "#ffffff",
    border: "#d0d7de",
    text: "#24292f",
    subtext: "#57606a",
    levels: ["#ebedf0", "#c9dcf5", "#9dc2f0", "#5aa0e8", "#0969da"],
  },
};

function levelFor(count, maxCount) {
  if (count === 0) return 0;
  if (maxCount <= 1) return 4;
  return Math.min(4, Math.max(1, Math.ceil((count / maxCount) * 4)));
}

function renderChartSVG(themeName, grid, totalCommits) {
  const theme = THEMES[themeName];
  const { gridStart, totalDays, counts } = grid;
  const maxCount = Math.max(1, ...counts);

  const cell = 10;
  const gap = 3;
  const pitch = cell + gap;
  const padding = { top: 74, right: 24, bottom: 20, left: 24 };
  const dayLabelWidth = 26;
  const gridOriginX = padding.left + dayLabelWidth;
  const gridOriginY = padding.top;

  const width = gridOriginX + GRID_WEEKS * pitch - gap + padding.right;
  const height = gridOriginY + 7 * pitch - gap + padding.bottom;

  const cells = [];
  let lastMonthLabel = null;
  const monthLabels = [];
  for (let day = 0; day < totalDays; day++) {
    const week = Math.floor(day / 7);
    const row = day % 7;
    const date = new Date(gridStart.getTime() + day * DAY_MS);
    const count = counts[day];
    const level = levelFor(count, maxCount);
    const x = gridOriginX + week * pitch;
    const y = gridOriginY + row * pitch;
    const dateLabel = date.toISOString().slice(0, 10);
    cells.push(
      `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cell}" height="${cell}" rx="2" fill="${theme.levels[level]}"><title>${dateLabel}: ${count} commit${count === 1 ? "" : "s"}</title></rect>`
    );

    if (row === 0) {
      const monthLabel = date.toLocaleString("en-US", { month: "short" });
      if (monthLabel !== lastMonthLabel) {
        lastMonthLabel = monthLabel;
        monthLabels.push(
          `<text x="${x.toFixed(1)}" y="${gridOriginY - 8}" font-size="11" fill="${theme.subtext}" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">${monthLabel}</text>`
        );
      }
    }
  }

  const dayLabels = [
    { row: 1, label: "Mon" },
    { row: 3, label: "Wed" },
    { row: 5, label: "Fri" },
  ]
    .map(
      ({ row, label }) =>
        `<text x="${(padding.left + dayLabelWidth - 6).toFixed(1)}" y="${(gridOriginY + row * pitch + cell - 1).toFixed(1)}" font-size="10" fill="${theme.subtext}" text-anchor="end" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">${label}</text>`
    )
    .join("\n  ");

  const legendX = width - padding.right - 5 * (cell + 2) - 40;
  const legendY = 34;
  const legend = theme.levels
    .map(
      (color, i) =>
        `<rect x="${(legendX + i * (cell + 2)).toFixed(1)}" y="${legendY}" width="${cell}" height="${cell}" rx="2" fill="${color}" />`
    )
    .join("");

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="meshmy organization commit activity, last ${GRID_WEEKS} weeks">
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="${theme.bg}" stroke="${theme.border}" />
  <text x="24" y="34" font-size="16" font-weight="600" fill="${theme.text}" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">meshmy Organization Activity</text>
  <text x="24" y="56" font-size="12" fill="${theme.subtext}" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">${totalCommits} commits by org members in the last ${GRID_WEEKS} weeks</text>
  <text x="${(legendX - 6).toFixed(1)}" y="${legendY + cell - 1}" font-size="10" fill="${theme.subtext}" text-anchor="end" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">Less</text>
  ${legend}
  <text x="${(legendX + 5 * (cell + 2) + 6).toFixed(1)}" y="${legendY + cell - 1}" font-size="10" fill="${theme.subtext}" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif">More</text>
  ${monthLabels.join("\n  ")}
  ${dayLabels}
  ${cells.join("\n  ")}
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
  // Fetch enough history to cover the full grid (53 weeks) plus a few days' slack.
  const sinceISO = new Date(Date.now() - (GRID_WEEKS * 7 + 7) * DAY_MS).toISOString();

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

  const grid = buildGrid(allOrgCommitDates);
  const totalCommits = allOrgCommitDates.length;

  await writeFile(path.join(PROFILE_DIR, "activity-graph-dark.svg"), renderChartSVG("dark", grid, totalCommits));
  await writeFile(path.join(PROFILE_DIR, "activity-graph-light.svg"), renderChartSVG("light", grid, totalCommits));

  const readmePath = path.join(PROFILE_DIR, "README.md");
  let readme = await readFile(readmePath, "utf8");
  readme = injectSection(readme, "REPOS", renderRepoTable(recentRepos, topRepos));
  await writeFile(readmePath, readme);

  console.log(`Updated profile for ${repos.length} repos, ${totalCommits} org-authored commits in last ${GRID_WEEKS} weeks.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
