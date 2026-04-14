#!/usr/bin/env node
/**
 * inject-asset-version.js
 *
 * Appends (or updates) a `?v=<BUILD_HASH>` cache-busting query parameter to
 * every local asset reference in every HTML file under `frontend/`.
 *
 * Targeted attributes:
 *   <script src="...">
 *   <script type="module" src="...">
 *   <link ... href="...">
 *
 * Only local paths are touched (paths starting with `js/`, `styles/`,
 * `vendor/`, or `/vendor/`, `/js/`, `/styles/`).
 * Absolute URLs (http/https), socket.io, and inline scripts are skipped.
 *
 * Scope: all *.html files directly inside `frontend/` (one level, no
 * recursion).  All project HTML pages live at this single level; if you add
 * HTML files in subdirectories, extend the walk accordingly.
 *
 * Usage:
 *   node scripts/inject-asset-version.js [hash]
 *
 *   The hash is resolved in this priority order:
 *     1. First CLI argument
 *     2. BUILD_HASH environment variable
 *     3. Current git commit short SHA  (git rev-parse --short HEAD)
 *     4. Date.now() as fallback
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── Resolve the build hash ────────────────────────────────────────────────────

function resolveHash() {
  if (process.argv[2]) {
    return process.argv[2];
  }
  if (process.env.BUILD_HASH) {
    return process.env.BUILD_HASH;
  }
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim();
  } catch (_) {
    // git not available or not a repo
  }
  return String(Date.now());
}

const BUILD_HASH = resolveHash();

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns true when a path points to a local asset that should be versioned.
 * Skips absolute URLs, data URIs, and the Socket.IO client.
 */
function isLocalAsset(assetPath) {
  if (!assetPath) return false;
  if (/^https?:\/\//i.test(assetPath)) return false;
  if (/^\/\//.test(assetPath)) return false;
  if (/^data:/i.test(assetPath)) return false;
  if (/socket\.io/i.test(assetPath)) return false;
  // Only version paths that clearly belong to our asset directories
  return /^\/?(js|styles|vendor)\//i.test(assetPath);
}

/**
 * Replaces or adds `?v=<hash>` on the given path value.
 */
function versionedPath(originalPath) {
  // Strip any existing standalone `v=` query parameter so re-running is
  // idempotent.  The pattern matches only when `v` is directly preceded by
  // `?` or `&` (i.e., it is its own parameter key, not a suffix of another
  // key such as `rev=`).  Stops at `&` or `#` to leave other params intact.
  const withoutVersion = originalPath
    .replace(/([?&])v=[^&#]*/g, '$1')   // remove v=... but keep the separator
    .replace(/[?&]$/, '');              // drop any trailing lone separator
  const separator = withoutVersion.includes('?') ? '&' : '?';
  return `${withoutVersion}${separator}v=${BUILD_HASH}`;
}

/**
 * Process the HTML content string and return an updated string with versioned
 * asset paths.  Uses a simple regex-based approach — no HTML parser required.
 */
function processHtml(html) {
  // Match <script ...src="..."> — covers both plain and type="module"
  html = html.replace(
    /(<script\b[^>]*?\ssrc=)(["'])([^"']*?)\2/gi,
    (match, prefix, quote, src) => {
      if (!isLocalAsset(src)) return match;
      return `${prefix}${quote}${versionedPath(src)}${quote}`;
    },
  );

  // Match <link ...href="..."> — covers stylesheets and other link types
  html = html.replace(
    /(<link\b[^>]*?\shref=)(["'])([^"']*?)\2/gi,
    (match, prefix, quote, href) => {
      if (!isLocalAsset(href)) return match;
      return `${prefix}${quote}${versionedPath(href)}${quote}`;
    },
  );

  return html;
}

// ── Walk the frontend directory ───────────────────────────────────────────────

const frontendDir = path.resolve(__dirname, '..', 'frontend');

const htmlFiles = fs
  .readdirSync(frontendDir)
  .filter((f) => f.endsWith('.html'))
  .map((f) => path.join(frontendDir, f));

let updatedCount = 0;

for (const filePath of htmlFiles) {
  const original = fs.readFileSync(filePath, 'utf8');
  const updated = processHtml(original);

  if (updated !== original) {
    fs.writeFileSync(filePath, updated, 'utf8');
    console.log(`  versioned: ${path.relative(process.cwd(), filePath)}`);
    updatedCount++;
  } else {
    console.log(`  unchanged: ${path.relative(process.cwd(), filePath)}`);
  }
}

console.log(`\nDone. BUILD_HASH=${BUILD_HASH}  (${updatedCount}/${htmlFiles.length} files updated)`);
