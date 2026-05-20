/**
 * Smoke test for FreeGameStore build.js. Mirrors the FAS test pattern.
 * Runs with Node's built-in test runner.
 *
 *   node --test test/build.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), "..");
const BUILD_JS = join(REPO_ROOT, "build.js");
const REAL_REGISTRY = join(REPO_ROOT, "registry.json");

const XSS_PAYLOAD = "<script>alert(1)</script>";
const FIXTURE_ID = "xss-fixture";

function runBuild() {
  const tmp = mkdtempSync(join(tmpdir(), "fgs-build-test-"));
  const tmpRegistry = join(tmp, "registry.json");
  const tmpDist = join(tmp, "dist");

  const realRegistry = JSON.parse(readFileSync(REAL_REGISTRY, "utf8"));
  realRegistry.games.push({
    id: FIXTURE_ID,
    name: "XSS Fixture",
    category: "arcade",
    icon: "&#9888;",
    iconBg: "#fee2e2",
    description: XSS_PAYLOAD,
    appUrl: "https://xss-fixture.freegamestore.online",
    repo: "freegamestore-online/xss-fixture",
    cfProject: "xss-fixture",
    type: "standalone",
    developer: "FreeGameStore",
  });
  writeFileSync(tmpRegistry, JSON.stringify(realRegistry, null, 2));

  execFileSync(process.execPath, [BUILD_JS], {
    env: { ...process.env, FGS_REGISTRY_PATH: tmpRegistry, FGS_DIST: tmpDist },
    cwd: REPO_ROOT,
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 60_000,
  });
  return { tmp, tmpDist, registry: realRegistry };
}

test("build.js writes index.html containing every game id", () => {
  const { tmp, tmpDist, registry } = runBuild();
  try {
    const indexHtml = readFileSync(join(tmpDist, "index.html"), "utf8");
    for (const g of registry.games) {
      assert.ok(
        indexHtml.includes(`data-id="${g.id}"`),
        `index.html is missing game id "${g.id}"`,
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("build.js escapes <script> payloads in game descriptions", () => {
  const { tmp, tmpDist } = runBuild();
  try {
    const detailHtml = readFileSync(
      join(tmpDist, "games", `${FIXTURE_ID}.html`),
      "utf8",
    );
    assert.ok(
      detailHtml.includes("&lt;script&gt;alert(1)&lt;/script&gt;"),
      "expected escaped <script> in detail page",
    );
    assert.ok(
      !detailHtml.includes(XSS_PAYLOAD),
      "raw <script> leaked unescaped into detail page",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function runBuildWithRegistry(games) {
  const tmp = mkdtempSync(join(tmpdir(), "fgs-build-validator-"));
  const tmpRegistry = join(tmp, "registry.json");
  const tmpDist = join(tmp, "dist");
  writeFileSync(tmpRegistry, JSON.stringify({ games }, null, 2));
  try {
    execFileSync(process.execPath, [BUILD_JS], {
      env: { ...process.env, FGS_REGISTRY_PATH: tmpRegistry, FGS_DIST: tmpDist },
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return { ok: true, stderr: "", tmp };
  } catch (err) {
    return { ok: false, stderr: (err.stderr && err.stderr.toString()) || err.message, tmp };
  }
}

const VALID_GAME = {
  id: "valid-game",
  name: "Valid",
  category: "arcade",
  icon: "&#9728;",
  iconBg: "#eff6ff",
  description: "ok",
  appUrl: "https://valid.freegamestore.online",
  repo: "freegamestore-online/valid",
  cfProject: "valid",
  type: "standalone",
  developer: "FreeGameStore",
};

test("validator rejects wrong-host appUrl", () => {
  const { ok, stderr, tmp } = runBuildWithRegistry([
    { ...VALID_GAME, appUrl: "https://evil.example.com" },
  ]);
  try {
    assert.equal(ok, false);
    assert.match(stderr, /appUrl must be https:\/\/\*\.freegamestore\.online/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("validator rejects bad iconBg", () => {
  const { ok, stderr, tmp } = runBuildWithRegistry([
    { ...VALID_GAME, iconBg: "url(javascript:alert(1))" },
  ]);
  try {
    assert.equal(ok, false);
    assert.match(stderr, /iconBg must be a #hex color/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("validator rejects bad id", () => {
  for (const badId of ["UPPER", "two words", "dot.sep", ""]) {
    const { ok, tmp } = runBuildWithRegistry([{ ...VALID_GAME, id: badId }]);
    try {
      assert.equal(ok, false, `id="${badId}" should have been rejected`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test("no inline onerror= attributes survive the build", () => {
  const { tmp, tmpDist } = runBuild();
  try {
    const indexHtml = readFileSync(join(tmpDist, "index.html"), "utf8");
    assert.ok(
      !/\sonerror\s*=/i.test(indexHtml),
      "index.html still emits inline onerror=",
    );
    assert.ok(
      /<div class="app-icon" data-letter="/.test(indexHtml),
      "expected at least one .app-icon with a data-letter attribute",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("cards have no inline style attribute; iconBg lives in card-styles.css", () => {
  const { tmp, tmpDist, registry } = runBuild();
  try {
    const indexHtml = readFileSync(join(tmpDist, "index.html"), "utf8");
    assert.ok(
      !/<div class="app-icon" data-letter="[^"]*" style=/.test(indexHtml),
      "inline style= leaked onto .app-icon",
    );
    const css = readFileSync(join(tmpDist, "card-styles.css"), "utf8");
    for (const g of registry.games) {
      assert.ok(
        css.includes(`.app-card[data-id="${g.id}"] .app-icon`),
        `card-styles.css missing rule for "${g.id}"`,
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function readHeadersCsp(tmpDist) {
  const headers = readFileSync(join(tmpDist, "_headers"), "utf8");
  const line = (headers.match(/Content-Security-Policy:\s*([^\n]+)/) || [])[1] || '';
  return { headers, csp: line };
}

test("_headers ships X-Frame-Options + HSTS + COOP + frame-ancestors", () => {
  const { tmp, tmpDist } = runBuild();
  try {
    const { headers, csp } = readHeadersCsp(tmpDist);
    assert.match(headers, /X-Frame-Options:\s*DENY/);
    assert.match(headers, /Strict-Transport-Security:\s*max-age=31536000/);
    assert.match(headers, /Cross-Origin-Opener-Policy:\s*same-origin/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("script-src has sha256 hash, no 'unsafe-inline'", () => {
  const { tmp, tmpDist } = runBuild();
  try {
    const { csp } = readHeadersCsp(tmpDist);
    const scriptSrc = (csp.match(/script-src[^;]*/) || [''])[0];
    assert.ok(scriptSrc.includes("'sha256-"), `script-src needs sha256 hash: ${scriptSrc}`);
    assert.ok(!scriptSrc.includes("'unsafe-inline'"), `script-src has unsafe-inline: ${scriptSrc}`);
    assert.ok(!csp.includes("raw.githubusercontent.com"), "raw.githubusercontent.com leaked into runtime CSP");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("img-src and connect-src allowlist specific hosts (no blanket https:)", () => {
  const { tmp, tmpDist } = runBuild();
  try {
    const { csp } = readHeadersCsp(tmpDist);
    const imgSrc = (csp.match(/img-src[^;]*/) || [''])[0];
    assert.ok(!/https:\s*[;\s]/.test(imgSrc), `img-src blanket https:: ${imgSrc}`);
    assert.ok(imgSrc.includes('freegamestore.online'), `img-src missing primary store: ${imgSrc}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("CSP reporting is wired (report-to + Reporting-Endpoints + handler file)", () => {
  const { tmp, tmpDist } = runBuild();
  try {
    const { headers, csp } = readHeadersCsp(tmpDist);
    assert.match(csp, /report-to csp-endpoint/);
    assert.match(csp, /report-uri \/v1\/csp-report/);
    assert.match(headers, /Reporting-Endpoints: csp-endpoint="\/v1\/csp-report"/);
    assert.ok(
      readFileSync(join(REPO_ROOT, "functions/v1/csp-report.js"), "utf8").includes("onRequestPost"),
      "functions/v1/csp-report.js missing or wrong shape",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("every local <script src> has a valid SRI integrity attribute", () => {
  const { tmp, tmpDist } = runBuild();
  try {
    const indexHtml = readFileSync(join(tmpDist, "index.html"), "utf8");
    const localScripts = indexHtml.match(/<script\s+src="\/[^"]+\.js"[^>]*>/g) || [];
    assert.ok(localScripts.length >= 2, `expected ≥2 local script tags, found ${localScripts.length}`);
    for (const tag of localScripts) {
      assert.match(tag, /integrity="sha256-[A-Za-z0-9+/=]+"/, `<script> missing integrity: ${tag}`);
    }
    assert.ok(!/{{SRI_[A-Z_]+}}/.test(indexHtml), "unsubstituted SRI placeholder");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("no <meta http-equiv=Content-Security-Policy> in index.html (headers only)", () => {
  const { tmp, tmpDist } = runBuild();
  try {
    const indexHtml = readFileSync(join(tmpDist, "index.html"), "utf8");
    assert.ok(
      !/meta\s+http-equiv="Content-Security-Policy"/i.test(indexHtml),
      "CSP meta re-appeared in index.html",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("validator rejects duplicate ids and unbounded/ctrl-char names", () => {
  let r = runBuildWithRegistry([{ ...VALID_GAME }, { ...VALID_GAME }]);
  try {
    assert.equal(r.ok, false);
    assert.match(r.stderr, /duplicate id/);
  } finally { rmSync(r.tmp, { recursive: true, force: true }); }
  r = runBuildWithRegistry([{ ...VALID_GAME, name: "x".repeat(200) }]);
  try {
    assert.equal(r.ok, false);
    assert.match(r.stderr, /name must be 1-80 chars/);
  } finally { rmSync(r.tmp, { recursive: true, force: true }); }
  r = runBuildWithRegistry([{ ...VALID_GAME, name: "tab" + String.fromCharCode(9) + "name" }]);
  try {
    assert.equal(r.ok, false);
    assert.match(r.stderr, /name must be/);
  } finally { rmSync(r.tmp, { recursive: true, force: true }); }
});
