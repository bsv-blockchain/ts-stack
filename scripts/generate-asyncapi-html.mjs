#!/usr/bin/env node
/**
 * Generate AsyncAPI HTML visualizations for all AsyncAPI spec files.
 *
 * Uses @asyncapi/generator + @asyncapi/html-template to produce a single-file
 * self-contained HTML app for each spec, output to docs/assets/asyncapi/<name>/.
 *
 * Run via:  pnpm docs:asyncapi
 *       or: node scripts/generate-asyncapi-html.mjs
 *
 * Dependencies (@asyncapi/generator and @asyncapi/html-template) are installed
 * as devDependencies via pnpm.  The html-template requires generator >=2.0.0.
 */

import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { readFileSync, writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Use createRequire so we can load CJS modules from node_modules
const require = createRequire(import.meta.url);
const Generator = require('@asyncapi/generator/lib/generator.js');

// ---------------------------------------------------------------------------
// Spec → output mapping
// ---------------------------------------------------------------------------
const SPECS = [
  {
    spec: 'specs/payments/brc29-payment-protocol.yaml',
    out:  'docs-site/public/assets/asyncapi/brc29',
  },
  {
    spec: 'specs/auth/brc31-handshake.yaml',
    out:  'docs-site/public/assets/asyncapi/brc31',
  },
  {
    spec: 'specs/messaging/authsocket-asyncapi.yaml',
    out:  'docs-site/public/assets/asyncapi/authsocket',
  },
  {
    spec: 'specs/sync/gasp-asyncapi.yaml',
    out:  'docs-site/public/assets/asyncapi/gasp',
  },
];

// ---------------------------------------------------------------------------
// Dark theme CSS injected into generated HTML (template has no dark mode param)
// ---------------------------------------------------------------------------
const DARK_CSS = `<style>
body,html{background:#0c0c14!important;color:#e2e8f0!important}
.bg-white{background-color:#14141f!important}
.bg-gray-100{background-color:#1a1a2a!important}
.bg-gray-200{background-color:#202035!important}
.bg-gray-800{background-color:#1a1a2a!important}
.text-gray-900{color:#e6edf3!important}
.text-gray-800{color:#d0d7de!important}
.text-gray-700{color:#c9d1d9!important}
.text-gray-600{color:#8b949e!important}
.text-gray-500{color:#6e7681!important}
.text-gray-200{color:#e6edf3!important}
</style>`;

function injectDarkTheme(htmlPath) {
  const html = readFileSync(htmlPath, 'utf-8');
  if (html.includes('DARK_CSS_INJECTED')) return;
  writeFileSync(htmlPath, html.replace('</head>', `<style>/* DARK_CSS_INJECTED */</style>` + DARK_CSS + '\n</head>'));
}

// ---------------------------------------------------------------------------
// Generate all specs
// ---------------------------------------------------------------------------
async function main() {
  let ok = 0;
  let fail = 0;

  for (const { spec, out } of SPECS) {
    const specAbs = resolve(ROOT, spec);
    const outAbs  = resolve(ROOT, out);
    console.log(`Generating: ${spec}`);
    console.log(`        to: ${out}/index.html`);

    try {
      const g = new Generator('@asyncapi/html-template', outAbs, {
        forceWrite: true,
        // singleFile=true bundles all CSS + JS inline — truly self-contained
        templateParams: { singleFile: 'true' },
      });
      await g.generateFromFile(specAbs);
      injectDarkTheme(resolve(outAbs, 'index.html'));
      console.log('  done.\n');
      ok++;
    } catch (err) {
      console.error(`  FAILED: ${err.message}\n`);
      fail++;
    }
  }

  console.log(`AsyncAPI HTML generation complete: ${ok} succeeded, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
