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

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Use createRequire so we can load CJS modules from node_modules
const require = createRequire(import.meta.url);
const Generator = require('@asyncapi/generator');

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
