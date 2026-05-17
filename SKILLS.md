# FreeGameStore — AI Agent Guide

Point your Claude Code, Codex, or any AI agent to this file for platform-aware development.

**Add to your CLAUDE.md or agent config:**
```
See https://freegamestore.online/skills.md for platform skills.
```

---

## Quick start — build a game with AI

```bash
# 1. Clone a template
gh repo clone freegamestore-online/template-game-canvas my-game
cd my-game

# 2. Replace placeholders
find . -type f \( -name "*.json" -o -name "*.tsx" -o -name "*.ts" -o -name "*.html" -o -name "*.md" -o -name "*.yaml" \) \
  -not -path "*/node_modules/*" -exec sed -i '' "s/APPNAME/my-game/g" {} \;

# 3. Install and run
pnpm install && pnpm dev
# Open http://localhost:5173

# 4. Build your game in web/src/App.tsx

# 5. Push to deploy
git push origin main
# → auto-deploys to my-game.freegamestore.online
```

Templates: `template-game-canvas` (2D), `template-game-grid` (puzzle), `template-game-cards` (card/tile), `template-game-3d` (Babylon.js).

---

## Per-repo CLAUDE.md convention

Every game repo ships a minimal `CLAUDE.md`. Keep it slim — platform-wide rules live here in SKILLS.md, not in per-repo copies.

````markdown
# <name>

<one-line description>

- Subdomain: `<name>.freegamestore.online`
- Dev: `pnpm install && pnpm dev`
- Build: `pnpm build`
- Deploy: `git push origin main` (auto-deploys via Cloudflare Pages)

Free, MIT-licensed, no tracking. For platform conventions, read
https://freegamestore.online/skills.md
before writing or changing anything.
````

---

## IMPORTANT: What NOT to do

- **Do NOT ask for Cloudflare API tokens, keys, or secrets.** All infra is automated via GitHub Actions.
- **Do NOT provision manually** — no `wrangler pages project create`, no DNS, no CF API calls.
- **Do NOT deploy manually** — push to main = auto-deploy. No `wrangler pages deploy`.
- **Do NOT use feature branches** — trunk-based development. Push to main only.
- **Do NOT create staging environments** — there's only production. Fix forward.
- **Do NOT build custom topbars or shells** — use `@freegamestore/games` SDK components.
- **Do NOT add splash screens** — show the game field immediately on load.

---

## How deployment works

```
Push to main → Cloudflare Pages auto-build → live at <game>.freegamestore.online
```

No manual deploy commands. Ever.

---

## Tech stack (required)

- TypeScript ^5.7, React ^19, Vite ^6, Tailwind CSS ^4.1, pnpm
- Node >=22
- Games SDK: `@freegamestore/games` (required for all games)
- 3D games: Babylon.js 7
- Linting: Biome

---

## Games SDK (`@freegamestore/games`)

**Every game MUST use the SDK components.** No custom topbars, no custom shells.

```bash
pnpm add @freegamestore/games
```

### GameShell — the root layout

Locks the game to `100svh`, prevents scroll, disables text selection.

```tsx
import { GameShell, GameTopbar } from '@freegamestore/games';

export default function App() {
  return (
    <GameShell topbar={<GameTopbar title="Chess" score={42} />}>
      {/* your game canvas / DOM */}
    </GameShell>
  );
}
```

### GameTopbar — the status bar

The **only** allowed topbar. Same font, padding, color tokens across every game.

```tsx
// Simple: just a score
<GameTopbar title="Tetris" score={42} />

// Custom stats
<GameTopbar
  title="Pac-Man"
  stats={[
    { label: 'Score', value: 1200, accent: true },
    { label: 'Lives', value: 3 },
    { label: 'Level', value: 5 },
  ]}
  actions={<GameButton size="sm" variant="ghost" onClick={pause}>Pause</GameButton>}
/>
```

### GameButton — touch-friendly buttons

Min 44px touch target. Three variants (`primary`, `secondary`, `ghost`), three sizes (`sm` 44px, `md` 48px, `lg` 56px).

### useLeaderboard — global leaderboard

```tsx
import { useLeaderboard, Leaderboard } from '@freegamestore/games';

function MyGame() {
  const { topScores, recentScores, submitScore, loading } = useLeaderboard('my-game');

  // Submit a score
  await submitScore(1500);

  // Render the leaderboard UI
  return <Leaderboard topScores={topScores} recentScores={recentScores} loading={loading} />;
}
```

### GameAuth — sign in with Google

```tsx
import { GameAuth } from '@freegamestore/games';

// Add to topbar actions slot
<GameTopbar title="My Game" actions={<GameAuth />} />
```

### useSound — muted by default

```tsx
import { useSound } from '@freegamestore/games';

function MyGame() {
  const { muted } = useSound();
  if (!muted) playSound(); // ALWAYS check before playing audio
}
```

### What NOT to do with the SDK

- Do NOT build custom Shell or topbar components
- Do NOT override `user-select`, `touch-action`, or `overflow` on root
- Do NOT pass custom colors to topbar or buttons — they use platform CSS tokens
- Do NOT play audio without checking `useSound().muted`

---

## No splash screens

Games must show the actual game field immediately on load.

- **Time-sensitive games** (Tetris, Snake): show game field with semi-transparent "Tap to play" overlay
- **Turn-based games** (Chess, Sudoku): start immediately, no overlay needed
- Game-over screens with "Play Again" are fine — they're after gameplay

---

## Project structure

```
game-name/
├── package.json           (root workspace)
├── pnpm-workspace.yaml
├── LICENSE                (MIT)
├── CLAUDE.md
├── .github/workflows/
│   ├── compliance.yml
│   └── ci.yml
└── web/
    ├── package.json       (@freegamestore/games in deps)
    ├── index.html
    ├── vite.config.ts
    ├── public/manifest.json
    └── src/
        ├── main.tsx
        ├── index.css      (Tailwind + brand CSS vars)
        └── App.tsx        (GameShell + your game)
```

---

## Mobile-first testing

FreeGameStore is a **mobile-first gaming platform**. Test on phone viewports first.

### Reference viewports

| Viewport | Device | Priority |
|----------|--------|----------|
| 320×568 | iPhone SE | **Critical** |
| 360×800 | Android | **Critical** |
| 393×852 | iPhone 15 | **Critical** |
| 568×320 | iPhone SE landscape | **Critical** |
| 667×375 | iPhone 8 landscape | **Critical** |

**Any scroll = fail.** The auditor tests every game across 12 viewports.

### Rules

- Game must fit viewport with **zero scroll** at every size from 320×568 up
- `html`, `body`, `#root`: `overflow: hidden`
- Use `100dvh` or `100svh` (not `100vh` — iOS Safari URL bar bug)
- Canvas/game area scales to available space, no fixed pixel sizes
- Buttons: minimum 44px touch target

Pre-publish check: `fgs screencheck`

---

## Brand design

- **Fonts**: Manrope (body) + Fraunces (display, 700-800)
- **Accent**: Emerald (#10b981)
- **CSS Variables**: `--paper`, `--ink`, `--muted`, `--line`, `--panel`, `--glass`, `--dock`, `--accent`
- **Dark mode**: `prefers-color-scheme: dark`
- **Layout**: GameShell + GameTopbar (fullscreen, no sidebar)

---

## Privacy rules

- ZERO analytics, tracking, cookies
- All user data in localStorage or via leaderboard API
- No third-party scripts except Google Fonts CDN

---

## Compliance checks (automated on push)

- `pnpm build` passes
- MIT `LICENSE` file exists
- No `.env.production` committed
- No tracking SDKs
- Brand fonts (Manrope + Fraunces) in `web/src/index.css`
- Brand CSS variables (`--paper`, `--ink`, `--accent`)
- HTML `lang`, `viewport`, `<title>` in `web/index.html`
- PWA `manifest.json`
- `freegamestore.online` link somewhere in `web/src/`
- Dark-mode support
- Largest JS asset under 300KB gzipped

---

## npm packages

| Package | What it does |
|---------|-------------|
| `@freegamestore/games` | React UI primitives (GameShell, GameTopbar, Leaderboard, auth, sounds) |
| `@freegamestore/cli` | CLI for scaffolding and publishing games |
| `@freegamestore/compliance` | Compliance checks (used by CLI and CI) |

**Never publish manually.** Version bump + push → OIDC publishes with provenance:

```bash
cd packages/games-sdk
npm version patch
git push --follow-tags
```

---

## Platform services

| Service | URL |
|---------|-----|
| Store | https://freegamestore.online |
| Publish portal | https://publish.freegamestore.online |
| Admin | https://admin.freegamestore.online |
| Agent (AI builder) | https://agent.freegamestore.online |
| Auth | https://auth.freegamestore.online |
| GitHub org | https://github.com/freegamestore-online |

---

## Support

| Need | Where |
|------|-------|
| Developer questions | [GitHub Discussions](https://github.com/freegamestore-online/freegamestore/discussions) |
| Bug reports | Issue on the game's GitHub repo |
| Creator applications | [Submissions](https://github.com/freegamestore-online/submissions/issues/new) |
| Platform docs | This file (SKILLS.md) |

All support is on GitHub. No email, Slack, or Discord.
