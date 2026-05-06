const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

// Read registry
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'registry.json'), 'utf8'));
const games = registry.games;

// Read templates
const indexTemplate = fs.readFileSync(path.join(ROOT, 'templates', 'index.html'), 'utf8');
const detailTemplate = fs.readFileSync(path.join(ROOT, 'templates', 'game-detail.html'), 'utf8');

// Helper: format category label (brain-training -> Brain Training)
function categoryLabel(cat) {
  return cat.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// Helper: type label
function typeLabel(type) {
  return type === 'standalone' ? 'Standalone (works offline)' : 'Connected (requires internet)';
}

// --- GitHub API helpers (used to source first-published + commit log) ---

const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

function ghFetch(urlPath) {
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'freegamestore-build',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (GH_TOKEN) headers['Authorization'] = `Bearer ${GH_TOKEN}`;
    const req = https.request(
      { hostname: 'api.github.com', path: urlPath, method: 'GET', headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error(`bad JSON from ${urlPath}: ${e.message}`)); }
          } else {
            const isRateLimit = res.statusCode === 403 && /rate limit/i.test(data);
            reject(new Error(`${urlPath} → ${res.statusCode}${isRateLimit ? ' (rate limited)' : ''}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const FMT_DATE = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
const FMT_SHORT = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Trim the GitHub API responses to only the fields the renderer reads.
 * Keeps the cache file ~30 KB instead of ~350 KB.
 */
function compactHistory(meta, commits) {
  return {
    meta: meta
      ? {
          created_at: meta.created_at ?? null,
          pushed_at: meta.pushed_at ?? null,
        }
      : null,
    commits: Array.isArray(commits)
      ? commits.map((c) => ({
          sha: c.sha,
          html_url: c.html_url,
          commit: {
            message: c.commit?.message ?? '',
            author: { date: c.commit?.author?.date ?? c.commit?.committer?.date ?? null },
          },
        }))
      : null,
  };
}

async function fetchGameHistory(repo) {
  // repo is "owner/name". Two parallel calls: repo metadata for created_at,
  // and the last 3 commits for the changelog. Failures degrade gracefully.
  try {
    const [meta, commits] = await Promise.all([
      ghFetch(`/repos/${repo}`),
      ghFetch(`/repos/${repo}/commits?per_page=3`),
    ]);
    return compactHistory(meta, commits);
  } catch (err) {
    console.warn(`  ! could not fetch history for ${repo}: ${err.message}`);
    return { meta: null, commits: null };
  }
}

// --- History cache (data/commit-history.json) ---
//
// CF Pages runs its own GitHub-integration build that doesn't have
// GITHUB_TOKEN. Caching lets that no-token build still produce correct
// output. The scheduled GH-Actions deploy refreshes the cache every 6h.
const CACHE_PATH = path.join(ROOT, 'data', 'commit-history.json');

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeCache(cache) {
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
}

async function fetchAllHistories(games) {
  const cache = readCache();
  const histories = await Promise.all(
    games.map(async (game) => {
      const fresh = await fetchGameHistory(game.repo);
      if (fresh.commits) {
        cache[game.repo] = fresh;
        return fresh;
      }
      const cached = cache[game.repo];
      if (cached?.commits) return cached;
      return fresh;
    }),
  );
  writeCache(cache);
  return histories;
}

function renderHistorySection(repo, history) {
  const githubAllUrl = `https://github.com/${repo}/commits/main`;
  if (!history.commits || history.commits.length === 0) {
    return `<section class="app-section">
      <h2>Recent updates</h2>
      <p style="color: var(--muted);">No updates yet — check back after the first deploy.</p>
      <p><a class="source-link" href="${githubAllUrl}" target="_blank" rel="noopener">See full history on GitHub &rarr;</a></p>
    </section>`;
  }
  const items = history.commits.map((c) => {
    const date = new Date(c.commit.author?.date ?? c.commit.committer?.date);
    const isoDate = date.toISOString().slice(0, 10);
    const shortDate = FMT_SHORT.format(date);
    const firstLine = (c.commit.message || '').split('\n')[0].trim();
    const msg = escapeHtml(firstLine).slice(0, 140);
    const sha = c.sha.slice(0, 7);
    return `<li class="version-row">
      <time datetime="${isoDate}" class="version-date">${shortDate}</time>
      <span class="version-msg">${msg}</span>
      <a class="version-sha" href="${c.html_url}" target="_blank" rel="noopener">${sha}</a>
    </li>`;
  }).join('\n');
  return `<section class="app-section">
      <h2>Recent updates</h2>
      <ul class="version-log">
${items}
      </ul>
      <p style="margin-top: 0.75rem;"><a class="source-link" href="${githubAllUrl}" target="_blank" rel="noopener">See full history on GitHub &rarr;</a></p>
    </section>`;
}

function renderPublishedLine(history) {
  if (!history.meta) return '';
  const created = history.meta.created_at ? new Date(history.meta.created_at) : null;
  const lastCommit = history.commits?.[0];
  const updated = lastCommit?.commit?.author?.date
    ? new Date(lastCommit.commit.author.date)
    : history.meta.pushed_at ? new Date(history.meta.pushed_at) : null;
  const parts = [];
  if (created) {
    parts.push(`First published <time datetime="${created.toISOString().slice(0,10)}">${FMT_DATE.format(created)}</time>`);
  }
  if (updated) {
    parts.push(`last updated <time datetime="${updated.toISOString().slice(0,10)}">${FMT_DATE.format(updated)}</time>`);
  }
  if (parts.length === 0) return '';
  return `<p class="published-line">${parts.join(' &middot; ')}</p>`;
}

// Ensure dist directories exist
fs.mkdirSync(path.join(DIST, 'games'), { recursive: true });

// --- Generate index.html ---

const categories = [...new Set(games.map(a => a.category))];
const filterButtons = [
  '<button class="filter-btn active" data-filter="all">All</button>',
  ...categories.map(cat =>
    `<button class="filter-btn" data-filter="${cat}">${categoryLabel(cat)}</button>`
  )
].join('\n        ');

const gameCards = games.map(game => {
  return `        <div class="app-card" data-category="${game.category}" data-about="/games/${game.id}.html">
          <div class="app-card-header">
            <div class="app-icon" style="background: ${game.iconBg};">${game.icon}</div>
            <div>
              <h3>${game.name}</h3>
              <div class="tag">${categoryLabel(game.category)}</div>
            </div>
          </div>
          <p>${game.description}</p>
          <div class="app-actions"><a href="${game.appUrl}" target="_blank" rel="noopener" class="app-btn-open">Play</a><a href="" class="app-link app-about">About &rarr;</a></div>
        </div>`;
}).join('\n\n');

// indexHtml is finalized inside the async IIFE below — cross-store
// registry fetch is async, and we want to embed it into the page.
let indexHtml = indexTemplate
  .replace('{{FILTER_BUTTONS}}', filterButtons)
  .replace('{{GAMES_GRID}}', gameCards);

// --- Generate game detail pages ---
// Wrapped in async IIFE because this file is CJS (no top-level await).

async function fetchAuditSummary() {
  // Fetch /v1/audit?store=games. Failures degrade gracefully — the
  // audit badge just doesn't render.
  try {
    const res = await new Promise((resolve, reject) => {
      const req = https.request(
        { hostname: 'api.freeappstore.online', path: '/v1/audit?store=games', method: 'GET' },
        (r) => {
          let data = '';
          r.on('data', (c) => (data += c));
          r.on('end', () => resolve({ status: r.statusCode, body: data }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    if (res.status !== 200) return new Map();
    const parsed = JSON.parse(res.body);
    const map = new Map();
    for (const s of parsed.summary ?? []) map.set(s.appId, s);
    return map;
  } catch (err) {
    console.warn(`  ! could not fetch audit summary: ${err.message}`);
    return new Map();
  }
}

function renderAuditBadge(summary) {
  if (!summary) {
    return '<p class="audit-badge audit-pending"><span class="dot"></span> Not yet audited</p>';
  }
  const total = summary.pass + summary.warn + summary.fail;
  if (summary.fail > 0) {
    return `<p class="audit-badge audit-fail"><span class="dot"></span> ${summary.fail} compliance failure${summary.fail === 1 ? '' : 's'} of ${total} checks &middot; <a href="https://api.freeappstore.online/v1/audit?app=${summary.appId}">details</a></p>`;
  }
  if (summary.warn > 0) {
    return `<p class="audit-badge audit-warn"><span class="dot"></span> ${summary.pass}/${total} compliance checks pass &middot; ${summary.warn} warning${summary.warn === 1 ? '' : 's'}</p>`;
  }
  return `<p class="audit-badge audit-pass"><span class="dot"></span> ${total}/${total} compliance checks pass</p>`;
}

function fetchManifest(appUrl) {
  return new Promise((resolve) => {
    try {
      const u = new URL('/manifest.json', appUrl);
      const req = https.request(
        { hostname: u.hostname, path: u.pathname, method: 'GET' },
        (r) => {
          let data = '';
          r.on('data', (c) => (data += c));
          r.on('end', () => {
            if (r.statusCode !== 200) return resolve(null);
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(null);
            }
          });
        },
      );
      req.on('error', () => resolve(null));
      req.setTimeout(6000, () => {
        req.destroy();
        resolve(null);
      });
      req.end();
    } catch {
      resolve(null);
    }
  });
}

function viewportCoverage(minWidth) {
  if (minWidth <= 320) return 99;
  if (minWidth <= 360) return 96;
  if (minWidth <= 414) return 88;
  if (minWidth <= 600) return 60;
  if (minWidth <= 768) return 35;
  if (minWidth <= 1024) return 20;
  return 10;
}

function renderViewportBadge(manifest) {
  if (!manifest) {
    return '<p class="audit-badge audit-pending"><span class="dot"></span> Viewport support: unknown</p>';
  }
  const orientation = typeof manifest.orientation === 'string' ? manifest.orientation : null;
  const minWidth =
    typeof manifest.min_viewport_width === 'number' ? manifest.min_viewport_width : null;
  if (orientation === null || minWidth === null) {
    return '<p class="audit-badge audit-pending"><span class="dot"></span> Viewport support: not declared</p>';
  }
  const coverage = viewportCoverage(minWidth);
  const orientLabel =
    orientation === 'any'
      ? 'portrait + landscape'
      : orientation === 'portrait' || orientation === 'portrait-primary'
        ? 'portrait only'
        : 'landscape only';
  const cls = coverage >= 90 ? 'audit-pass' : coverage >= 50 ? 'audit-warn' : 'audit-fail';
  return `<p class="audit-badge ${cls}"><span class="dot"></span> Works on ~${coverage}% of devices · ${orientLabel} · min ${minWidth}px wide</p>`;
}

async function fetchCrossStoreRegistry() {
  // Pull the OTHER store's registry so the homepage search can
  // federate. Failure → empty registry, search still works locally.
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'raw.githubusercontent.com',
        path: '/freeappstore-online/freeappstore/main/registry.json',
        method: 'GET',
      },
      (r) => {
        let data = '';
        r.on('data', (c) => (data += c));
        r.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({
              items: parsed.apps ?? [],
              domain: 'freeappstore.online',
              path: 'apps',
            });
          } catch {
            resolve({ items: [], domain: 'freeappstore.online', path: 'apps' });
          }
        });
      },
    );
    req.on('error', () => resolve({ items: [], domain: 'freeappstore.online', path: 'apps' }));
    req.end();
  });
}

(async () => {
console.log(`Fetching commit history for ${games.length} games (with disk cache fallback)...`);
const [histories, auditMap, crossRegistry, manifests] = await Promise.all([
  fetchAllHistories(games),
  fetchAuditSummary(),
  fetchCrossStoreRegistry(),
  Promise.all(games.map((g) => fetchManifest(g.appUrl))),
]);

indexHtml = indexHtml.replace(
  '{{CROSS_STORE_REGISTRY}}',
  JSON.stringify(crossRegistry).replace(/</g, '\\u003c'),
);
fs.writeFileSync(path.join(DIST, 'index.html'), indexHtml);

const okCount = histories.filter((h) => Array.isArray(h?.commits) && h.commits.length > 0).length;
console.log(`  ${okCount}/${games.length} games got commit history`);
console.log(`  ${auditMap.size} games have audit results`);
console.log(`  ${crossRegistry.items.length} apps available for cross-store search`);

games.forEach((game, i) => {
  const offline = game.type === 'standalone' ? 'Yes' : 'When cached';
  const account = game.type === 'standalone' ? 'Not required' : 'Not required';
  const history = histories[i];

  let html = detailTemplate
    .replace(/\{\{NAME\}\}/g, game.name)
    .replace(/\{\{NAME_LOWER\}\}/g, game.name.toLowerCase())
    .replace(/\{\{ID\}\}/g, game.id)
    .replace(/\{\{ICON\}\}/g, game.icon)
    .replace(/\{\{ICON_BG\}\}/g, game.iconBg)
    .replace(/\{\{CATEGORY_LABEL\}\}/g, categoryLabel(game.category))
    .replace(/\{\{DESCRIPTION\}\}/g, game.description)
    .replace(/\{\{APP_URL\}\}/g, game.appUrl)
    .replace(/\{\{REPO\}\}/g, game.repo)
    .replace(/\{\{TYPE_LABEL\}\}/g, typeLabel(game.type))
    .replace(/\{\{DEVELOPER\}\}/g, game.developer || 'FreeGameStore')
    .replace(/\{\{AUTHOR\}\}/g, game.author || game.developer || 'FreeGameStore')
    .replace(/\{\{OFFLINE\}\}/g, offline)
    .replace(/\{\{ACCOUNT\}\}/g, account)
    .replace(/\{\{PUBLISHED_LINE\}\}/g, renderPublishedLine(history))
    .replace(/\{\{HISTORY_SECTION\}\}/g, renderHistorySection(game.repo, history))
    .replace(/\{\{AUDIT_BADGE\}\}/g, renderAuditBadge(auditMap.get(game.id)))
    .replace(/\{\{VIEWPORT_BADGE\}\}/g, renderViewportBadge(manifests[i]));

  fs.writeFileSync(path.join(DIST, 'games', `${game.id}.html`), html);
});

// --- Generate sitemap.xml ---

const today = new Date().toISOString().split('T')[0];
const sitemapEntries = [
  '  <url><loc>https://freegamestore.online/</loc><priority>1.0</priority></url>',
  '  <url><loc>https://freegamestore.online/about.html</loc><priority>0.8</priority></url>',
  '  <url><loc>https://freegamestore.online/contribute.html</loc><priority>0.7</priority></url>',
  '  <url><loc>https://freegamestore.online/build-with-ai.html</loc><priority>0.85</priority></url>',
  '  <url><loc>https://freegamestore.online/ai/claude-code.html</loc><priority>0.7</priority></url>',
  '  <url><loc>https://freegamestore.online/ai/cursor.html</loc><priority>0.7</priority></url>',
  '  <url><loc>https://freegamestore.online/ai/github-copilot.html</loc><priority>0.7</priority></url>',
  '  <url><loc>https://freegamestore.online/ai/aider.html</loc><priority>0.7</priority></url>',
  '  <url><loc>https://freegamestore.online/ai/codex.html</loc><priority>0.7</priority></url>',
  '  <url><loc>https://freegamestore.online/ai/windsurf.html</loc><priority>0.7</priority></url>',
  '  <url><loc>https://freegamestore.online/ai/zed.html</loc><priority>0.7</priority></url>',
  '  <url><loc>https://freegamestore.online/ai/continue.html</loc><priority>0.7</priority></url>',
  '  <url><loc>https://freegamestore.online/ai/cline.html</loc><priority>0.7</priority></url>',
  '  <url><loc>https://freegamestore.online/ai/chatgpt-web.html</loc><priority>0.7</priority></url>',
  '  <url><loc>https://freegamestore.online/guidelines.html</loc><priority>0.7</priority></url>',
  '  <url><loc>https://freegamestore.online/leaderboard.html</loc><priority>0.7</priority></url>',
  '  <url><loc>https://freegamestore.online/privacy.html</loc><priority>0.5</priority></url>',
  '  <url><loc>https://freegamestore.online/terms.html</loc><priority>0.5</priority></url>',
  ...games.map(game =>
    `  <url><loc>https://freegamestore.online/games/${game.id}.html</loc><priority>0.9</priority></url>`
  )
];

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${sitemapEntries.join('\n')}
</urlset>
`;

fs.writeFileSync(path.join(DIST, 'sitemap.xml'), sitemap);

// --- Copy static assets ---

const filesToCopy = [
  'style.css',
  'search.js',
  'favicon.svg',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'robots.txt',
  '404.html',
  'about.html',
  'contribute.html',
  'guidelines.html',
  'leaderboard.html',
  'privacy.html',
  'terms.html',
  'build-with-ai.html',
];

filesToCopy.forEach(file => {
  const src = path.join(ROOT, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(DIST, file));
  }
});

// AI tool guides under /ai/<slug>.html.
const aiSrcDir = path.join(ROOT, 'ai');
if (fs.existsSync(aiSrcDir)) {
  const aiDestDir = path.join(DIST, 'ai');
  fs.mkdirSync(aiDestDir, { recursive: true });
  for (const f of fs.readdirSync(aiSrcDir)) {
    if (!f.endsWith('.html')) continue;
    fs.copyFileSync(path.join(aiSrcDir, f), path.join(aiDestDir, f));
  }
}

console.log(`Built ${games.length} game cards into dist/index.html`);
console.log(`Generated ${games.length} detail pages in dist/games/`);
console.log('Generated dist/sitemap.xml');
console.log('Copied static assets');
})().catch((err) => {
  console.error('build failed:', err);
  process.exit(1);
});
