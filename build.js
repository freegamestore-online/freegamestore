const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const ROOT = __dirname;
// DIST and the registry path can be overridden via env vars so the test
// suite in test/build.test.mjs can run a parallel build against a temp
// registry without touching real outputs.
const DIST = process.env.FGS_DIST ? path.resolve(process.env.FGS_DIST) : path.join(ROOT, 'dist');
const REGISTRY_PATH = process.env.FGS_REGISTRY_PATH ? path.resolve(process.env.FGS_REGISTRY_PATH) : path.join(ROOT, 'registry.json');

// Read registry
const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const games = registry.games;

// Registry shape validator — stop malformed/malicious entries at build time.
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const COLOR_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const URL_RE = /^https:\/\/[a-z0-9.-]+\.freegamestore\.online(?:\/.*)?$/;
function safeText(s, max) {
  return typeof s === 'string' && s.length > 0 && s.length <= max && !/[\x00-\x1f\x7f]/.test(s);
}
function validateRegistry(items) {
  const errors = [];
  const seenIds = new Set();
  for (const g of items) {
    if (!g.id || !ID_RE.test(g.id)) errors.push(`bad id: ${JSON.stringify(g.id)}`);
    else if (seenIds.has(g.id)) errors.push(`duplicate id: ${JSON.stringify(g.id)}`);
    else seenIds.add(g.id);
    if (!safeText(g.name, 80)) errors.push(`${g.id}: name must be 1-80 chars without control chars`);
    if (!g.appUrl || !URL_RE.test(g.appUrl)) errors.push(`${g.id}: appUrl must be https://*.freegamestore.online, got ${JSON.stringify(g.appUrl)}`);
    if (g.iconBg && !COLOR_RE.test(g.iconBg)) errors.push(`${g.id}: iconBg must be a #hex color, got ${JSON.stringify(g.iconBg)}`);
    if (g.category != null && !safeText(g.category, 80)) errors.push(`${g.id}: bad category ${JSON.stringify(g.category)}`);
    if (g.description != null && !safeText(g.description, 500)) errors.push(`${g.id}: description must be 1-500 chars without control chars`);
    if (g.developer != null && !safeText(g.developer, 60)) errors.push(`${g.id}: bad developer ${JSON.stringify(g.developer)}`);
    if (g.author != null && !safeText(g.author, 60)) errors.push(`${g.id}: bad author ${JSON.stringify(g.author)}`);
    if (g.repo != null && (typeof g.repo !== 'string' || g.repo.length > 100 || !/^[\w.-]+\/[\w.-]+$/.test(g.repo))) {
      errors.push(`${g.id}: repo must be "owner/name", got ${JSON.stringify(g.repo)}`);
    }
  }
  if (errors.length) {
    console.error('Registry validation failed:\n  - ' + errors.join('\n  - '));
    process.exit(1);
  }
}
validateRegistry(games);

// Read templates
const indexTemplate = fs.readFileSync(path.join(ROOT, 'templates', 'index.html'), 'utf8');
const detailTemplate = fs.readFileSync(path.join(ROOT, 'templates', 'game-detail.html'), 'utf8');

// CF Web Analytics — token from FGS_CF_BEACON_TOKEN at build time. Snippet is
// the standard CF Insights beacon; cookieless, no PII. If unset, an HTML
// comment is emitted so the page validates but no beacon ships.
const CF_BEACON_TOKEN = (process.env.FGS_CF_BEACON_TOKEN || '').trim();
const CF_BEACON_SNIPPET = CF_BEACON_TOKEN && /^[a-f0-9]{32,}$/i.test(CF_BEACON_TOKEN)
  ? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${CF_BEACON_TOKEN}"}'></script>`
  : '<!-- CF Web Analytics: FGS_CF_BEACON_TOKEN unset at build time -->';

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
      <p class="text-muted">No updates yet — check back after the first deploy.</p>
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
      <p class="mt-sm"><a class="source-link" href="${githubAllUrl}" target="_blank" rel="noopener">See full history on GitHub &rarr;</a></p>
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

// Build game cards — compact letter-badge layout, Figma 2026
// Per-card icon backgrounds live in dist/card-styles.css so a malformed
// iconBg slipping past validation never reaches an HTML style attribute.
function escapeAttrCss(s) { return String(s).replace(/[^a-z0-9_-]/gi, '_'); }
const cardIconBackgrounds = games
  .map(g => {
    const bg = g.iconBg || '#10b981';
    const id = escapeAttrCss(g.id);
    return `.app-card[data-id="${id}"] .app-icon { background: ${bg}; }\n.app-hero-icon[data-id="${id}"] { background: ${bg}; }`;
  })
  .join('\n');

const gameCards = games.map(game => {
  const letter = escapeHtml((game.name || '?').trim().charAt(0).toUpperCase());
  return `        <div class="app-card compact" data-id="${escapeHtml(game.id)}" data-category="${escapeHtml(game.category)}" data-about="/games/${escapeHtml(game.id)}.html">
          <div class="app-icon" data-letter="${letter}">
            <img src="${escapeHtml(game.appUrl)}/apple-touch-icon.png" alt="" loading="lazy" />
          </div>
          <div class="app-body">
            <span class="app-name">${escapeHtml(game.name)}</span>
            <span class="app-meta">${escapeHtml(categoryLabel(game.category))}</span>
          </div>
          <a href="${escapeHtml(game.appUrl)}" target="_blank" rel="noopener" class="app-cta" aria-label="Play ${escapeHtml(game.name)}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="6,4 20,12 6,20" /></svg>
            <span class="cta-label">Play</span>
          </a>
        </div>`;
}).join('\n\n');

// SHA-256 of the inline no-flash theme bootstrap so CSP can whitelist it
// without 'unsafe-inline'. The bootstrap is the first <script> inside <head>.
const inlineScriptMatch = indexTemplate.match(/<head>[\s\S]*?<script>([\s\S]*?)<\/script>/);
if (!inlineScriptMatch) {
  console.error('Could not locate the inline bootstrap <script> for CSP hashing');
  process.exit(1);
}
const inlineScriptHash = 'sha256-' + crypto.createHash('sha256').update(inlineScriptMatch[1]).digest('base64');

// SRI hashes for local scripts — browsers refuse to execute if the file
// content changes (CDN compromise, in-flight tamper).
function sriHash(filename) {
  const content = fs.readFileSync(path.join(ROOT, filename));
  return 'sha256-' + crypto.createHash('sha256').update(content).digest('base64');
}
const sriHashes = {
  SEARCH_JS: sriHash('search.js'),
  STOREFRONT_JS: sriHash('storefront.js'),
  THEME_JS: sriHash('theme.js'),
  DETAIL_PAGE_JS: sriHash('detail-page.js'),
};

// indexHtml is finalized inside the async IIFE below — cross-store
// registry fetch is async, and we want to embed it into the page.
let indexHtml = indexTemplate
  .replaceAll('__CF_BEACON__', CF_BEACON_SNIPPET)
  .replaceAll('{{INLINE_SCRIPT_HASH}}', inlineScriptHash)
  .replaceAll('{{GAMES_GRID}}', gameCards)
  .replaceAll('{{GAMES_COUNT}}', String(games.length));
for (const [k, v] of Object.entries(sriHashes)) {
  indexHtml = indexHtml.replaceAll(`{{SRI_${k}}}`, v);
}

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
fs.writeFileSync(path.join(DIST, 'card-styles.css'), cardIconBackgrounds + '\n');

// --- Quality Dashboard (mirrors /tmp/freeappstore/build.js) ---
const qualityTemplate = fs.readFileSync(path.join(ROOT, 'templates', 'quality.html'), 'utf8');
const qualityRegistry = {
  apps: (crossRegistry.items || []).map(a => ({ id: a.id, name: a.name, appUrl: a.appUrl })),
  games: games.map(g => ({ id: g.id, name: g.name, appUrl: g.appUrl })),
  // Platform fixtures — deliberately-broken control cases used to verify
  // the auditor flags each layout-bug class correctly. Visible from the
  // /quality dashboard but filtered out of the main store browse.
  fixtures: [
    { id: 'auditor-fixture', name: 'Auditor Fixture', appUrl: '/audit-fixture/', fixture: true,
      description: 'Deliberately-broken control cases. Each scenario reproduces a known layout bug to verify the platform auditor flags it correctly.' },
  ],
};
const qualityHtml = qualityTemplate
  .replaceAll('__CF_BEACON__', CF_BEACON_SNIPPET)
  .replace(
    '{{REGISTRIES_JSON}}',
    JSON.stringify(qualityRegistry).replace(/</g, '\\u003c'),
  );
fs.writeFileSync(path.join(DIST, 'quality.html'), qualityHtml);
console.log(`  /quality dashboard generated for ${qualityRegistry.games.length} games + ${qualityRegistry.apps.length} apps`);

const okCount = histories.filter((h) => Array.isArray(h?.commits) && h.commits.length > 0).length;
console.log(`  ${okCount}/${games.length} games got commit history`);
console.log(`  ${auditMap.size} games have audit results`);
console.log(`  ${crossRegistry.items.length} apps available for cross-store search`);

games.forEach((game, i) => {
  const offline = game.type === 'standalone' ? 'Yes' : 'When cached';
  const account = game.type === 'standalone' ? 'Not required' : 'Not required';
  const history = histories[i];

  // XSS defense: every user-facing field that's not pre-validated to a
  // safe shape (id, iconBg, appUrl all pass the validator above) is
  // escaped here. NAME / DESCRIPTION / AUTHOR / DEVELOPER are free-form.
  let html = detailTemplate
    .replaceAll('__CF_BEACON__', CF_BEACON_SNIPPET)
    .replace(/\{\{NAME\}\}/g, escapeHtml(game.name))
    .replace(/\{\{NAME_LOWER\}\}/g, escapeHtml(game.name.toLowerCase()))
    .replace(/\{\{ID\}\}/g, escapeHtml(game.id))
    .replace(/\{\{ICON\}\}/g, game.icon) // pre-validated HTML entity from registry
    .replace(/\{\{ICON_BG\}\}/g, escapeHtml(game.iconBg))
    .replace(/\{\{CATEGORY_LABEL\}\}/g, escapeHtml(categoryLabel(game.category)))
    .replace(/\{\{DESCRIPTION\}\}/g, escapeHtml(game.description))
    .replace(/\{\{APP_URL\}\}/g, escapeHtml(game.appUrl))
    .replace(/\{\{REPO\}\}/g, escapeHtml(game.repo))
    .replace(/\{\{TYPE_LABEL\}\}/g, escapeHtml(typeLabel(game.type)))
    .replace(/\{\{DEVELOPER\}\}/g, escapeHtml(game.developer || 'FreeGameStore'))
    .replace(/\{\{AUTHOR\}\}/g, escapeHtml(game.author || game.developer || 'FreeGameStore'))
    .replace(/\{\{OFFLINE\}\}/g, offline)
    .replace(/\{\{ACCOUNT\}\}/g, account)
    .replace(/\{\{PUBLISHED_LINE\}\}/g, renderPublishedLine(history))
    .replace(/\{\{HISTORY_SECTION\}\}/g, renderHistorySection(game.repo, history))
    .replace(/\{\{AUDIT_BADGE\}\}/g, renderAuditBadge(auditMap.get(game.id)))
    .replace(/\{\{VIEWPORT_BADGE\}\}/g, renderViewportBadge(manifests[i]));

  for (const [k, v] of Object.entries(sriHashes)) {
    html = html.replaceAll(`{{SRI_${k}}}`, v);
  }

  fs.writeFileSync(path.join(DIST, 'games', `${game.id}.html`), html);
});

// --- Generate sitemap.xml ---

const today = new Date().toISOString().split('T')[0];
const sitemapEntries = [
  '  <url><loc>https://freegamestore.online/</loc><priority>1.0</priority></url>',
  '  <url><loc>https://freegamestore.online/about.html</loc><priority>0.8</priority></url>',
  '  <url><loc>https://freegamestore.online/contribute.html</loc><priority>0.7</priority></url>',
  '  <url><loc>https://freegamestore.online/get-started.html</loc><priority>0.9</priority></url>',
  '  <url><loc>https://freegamestore.online/pricing.html</loc><priority>0.8</priority></url>',
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
  'storefront.js',
  'theme.js',
  'detail-page.js',
  'quality.js',
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
  'pricing.html',
  'get-started.html',
  'SKILLS.md',
  'llms.txt',
];

// Security headers via CF Pages _headers — single source of truth for CSP and
// every other security header. <meta> CSP intentionally absent (frame-ancestors,
// report-to, HSTS can't ride in <meta>). script-src hash whitelists only the
// inline theme bootstrap.
const csp = [
  "default-src 'self'",
  "img-src 'self' https://*.freegamestore.online https://*.freeappstore.online data:",
  `script-src 'self' '${inlineScriptHash}' https://static.cloudflareinsights.com`,
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "connect-src 'self' https://*.freegamestore.online https://api.freeappstore.online https://cloudflareinsights.com",
  "frame-src https://*.freegamestore.online https://*.freeappstore.online https://*.progamestore.online",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "object-src 'none'",
  "upgrade-insecure-requests",
  // CSP3 reporting + back-compat directive.
  "report-to csp-endpoint",
  "report-uri /v1/csp-report",
].join('; ');

fs.writeFileSync(path.join(DIST, '_headers'), [
  '/*',
  '  X-Frame-Options: DENY',
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: strict-origin-when-cross-origin',
  '  Strict-Transport-Security: max-age=31536000; includeSubDomains',
  '  Cross-Origin-Opener-Policy: same-origin',
  '  Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), midi=()',
  '  Reporting-Endpoints: csp-endpoint="/v1/csp-report"',
  `  Content-Security-Policy: ${csp}`,
  `  Content-Security-Policy-Report-Only: ${csp}`,
  '',
].join('\n'));

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

// Auditor fixture under /audit-fixture/. Single static page with
// query-param-driven scenarios — see audit-fixture/index.html for the
// scenarios + their expected audit verdicts. Hosted same-origin so the
// /quality dashboard can iframe it without any CORS dance.
const fixtureSrcDir = path.join(ROOT, 'audit-fixture');
if (fs.existsSync(fixtureSrcDir)) {
  const fixtureDestDir = path.join(DIST, 'audit-fixture');
  fs.mkdirSync(fixtureDestDir, { recursive: true });
  for (const f of fs.readdirSync(fixtureSrcDir)) {
    fs.copyFileSync(path.join(fixtureSrcDir, f), path.join(fixtureDestDir, f));
  }
}

// .well-known/ — MCP discovery and other standards
const wellKnownSrc = path.join(ROOT, '.well-known');
if (fs.existsSync(wellKnownSrc)) {
  const wellKnownDest = path.join(DIST, '.well-known');
  fs.mkdirSync(wellKnownDest, { recursive: true });
  for (const f of fs.readdirSync(wellKnownSrc)) {
    fs.copyFileSync(path.join(wellKnownSrc, f), path.join(wellKnownDest, f));
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
