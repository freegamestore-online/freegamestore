const fs = require('fs');
const path = require('path');

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

let indexHtml = indexTemplate
  .replace('{{FILTER_BUTTONS}}', filterButtons)
  .replace('{{GAMES_GRID}}', gameCards);

fs.writeFileSync(path.join(DIST, 'index.html'), indexHtml);

// --- Generate game detail pages ---

games.forEach(game => {
  const offline = game.type === 'standalone' ? 'Yes' : 'When cached';
  const account = game.type === 'standalone' ? 'Not required' : 'Not required';

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
    .replace(/\{\{DEVELOPER\}\}/g, game.developer)
    .replace(/\{\{OFFLINE\}\}/g, offline)
    .replace(/\{\{ACCOUNT\}\}/g, account);

  fs.writeFileSync(path.join(DIST, 'games', `${game.id}.html`), html);
});

// --- Generate sitemap.xml ---

const sitemapEntries = [
  '  <url><loc>https://freegamestore.online/</loc><priority>1.0</priority></url>',
  '  <url><loc>https://freegamestore.online/about.html</loc><priority>0.8</priority></url>',
  '  <url><loc>https://freegamestore.online/contribute.html</loc><priority>0.7</priority></url>',
  '  <url><loc>https://freegamestore.online/guidelines.html</loc><priority>0.7</priority></url>',
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
  'favicon.svg',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'robots.txt',
  '404.html',
  'about.html',
  'contribute.html',
  'guidelines.html',
  'privacy.html',
  'terms.html'
];

filesToCopy.forEach(file => {
  const src = path.join(ROOT, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(DIST, file));
  }
});

console.log(`Built ${games.length} game cards into dist/index.html`);
console.log(`Generated ${games.length} detail pages in dist/games/`);
console.log('Generated dist/sitemap.xml');
console.log('Copied static assets');
