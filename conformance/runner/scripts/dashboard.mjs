#!/usr/bin/env node
/**
 * dashboard.mjs — BSV SDK Conformance static HTML summary generator
 *
 * Reads conformance/reports/go-results.json and conformance/reports/ts-results.json,
 * then writes conformance/reports/dashboard.html — a single-file HTML page with
 * pass-rate gauges (CSS only, no external deps) and a per-category table.
 *
 * Usage:
 *   node conformance/runner/scripts/dashboard.mjs [--reports-dir <path>]
 *
 * Default reports-dir: <repo-root>/conformance/reports
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..", "..", "..");

// Parse --reports-dir argument.
const args = process.argv.slice(2);
let reportsDir = resolve(repoRoot, "conformance", "reports");
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--reports-dir" && args[i + 1]) {
    reportsDir = resolve(args[i + 1]);
    i++;
  }
}

/** Load a JSON report file; returns null if missing. */
function loadReport(filename) {
  const p = resolve(reportsDir, filename);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.warn(`Warning: could not parse ${p}: ${e.message}`);
    return null;
  }
}

const goReport = loadReport("go-results.json");
const tsReport = loadReport("ts-results.json");

if (!goReport && !tsReport) {
  console.error(
    `No report files found in ${reportsDir}.\n` +
      "Run the conformance runners first to generate go-results.json and/or ts-results.json."
  );
  process.exit(1);
}

/** Return a colour class based on pass rate (0–1). */
function rateClass(rate) {
  if (rate >= 0.9) return "good";
  if (rate >= 0.8) return "warn";
  return "bad";
}

/** Format a pass rate as a percentage string. */
function pct(rate) {
  if (rate == null) return "N/A";
  return (rate * 100).toFixed(1) + "%";
}

/** Build the SVG-based CSS gauge for a given pass rate. */
function gauge(rate, label) {
  if (rate == null) {
    return `<div class="gauge-wrap"><div class="gauge-label">${label}</div><div class="gauge-na">N/A</div></div>`;
  }
  const cls = rateClass(rate);
  // SVG circle gauge: circumference = 2πr ≈ 2*π*40 ≈ 251.3
  const r = 40;
  const circ = 2 * Math.PI * r;
  const fill = circ * rate;
  const gap = circ - fill;
  const colorMap = { good: "#22c55e", warn: "#eab308", bad: "#ef4444" };
  const color = colorMap[cls];
  return `
  <div class="gauge-wrap">
    <div class="gauge-label">${label}</div>
    <svg class="gauge-svg" viewBox="0 0 100 100" width="110" height="110">
      <circle cx="50" cy="50" r="${r}" fill="none" stroke="#e5e7eb" stroke-width="12"/>
      <circle cx="50" cy="50" r="${r}" fill="none"
        stroke="${color}" stroke-width="12"
        stroke-dasharray="${fill.toFixed(2)} ${gap.toFixed(2)}"
        stroke-linecap="round"
        transform="rotate(-90 50 50)"/>
      <text x="50" y="55" text-anchor="middle" font-size="16" font-weight="bold" fill="${color}">${pct(rate)}</text>
    </svg>
  </div>`;
}

/** Build the per-category table HTML for a report. */
function categoryTable(report, title) {
  if (!report || !report.categories || report.categories.length === 0) {
    return `<p class="missing">No category data for ${title}.</p>`;
  }
  const sorted = [...report.categories].sort((a, b) =>
    a.category.localeCompare(b.category)
  );
  const rows = sorted
    .map((cat) => {
      const rate = cat.total > 0 ? cat.passed / cat.total : 0;
      const cls = rateClass(rate);
      return `
      <tr>
        <td>${htmlEscape(cat.category)}</td>
        <td class="num ${cls}">${pct(rate)}</td>
        <td class="num ok">${cat.passed}</td>
        <td class="num fail">${cat.failed}</td>
        <td class="num skip">${cat.skipped}</td>
        <td class="num">${cat.total}</td>
      </tr>`;
    })
    .join("");
  return `
  <h3>${htmlEscape(title)}</h3>
  <table>
    <thead>
      <tr>
        <th>Category</th>
        <th>Pass Rate</th>
        <th class="num">Passed</th>
        <th class="num">Failed</th>
        <th class="num">Skipped</th>
        <th class="num">Total</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function htmlEscape(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function summaryRow(report, name) {
  if (!report) return "";
  const cls = rateClass(report.pass_rate);
  return `
  <tr>
    <td>${htmlEscape(name)}</td>
    <td class="num ${cls}">${pct(report.pass_rate)}</td>
    <td class="num ok">${report.passed}</td>
    <td class="num fail">${report.failed}</td>
    <td class="num skip">${report.skipped}</td>
    <td class="num">${report.total}</td>
    <td>${htmlEscape(report.generated_at || "")}</td>
  </tr>`;
}

const generatedAt = new Date().toISOString();

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>BSV SDK Conformance Dashboard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #f8fafc;
      color: #1e293b;
      padding: 2rem;
    }
    h1 { font-size: 1.75rem; margin-bottom: 0.25rem; }
    .subtitle { color: #64748b; font-size: 0.9rem; margin-bottom: 2rem; }
    h2 { font-size: 1.25rem; margin: 2rem 0 1rem; border-bottom: 2px solid #e2e8f0; padding-bottom: 0.5rem; }
    h3 { font-size: 1rem; margin: 1.5rem 0 0.75rem; color: #475569; }
    .gauges { display: flex; gap: 2rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
    .gauge-wrap { display: flex; flex-direction: column; align-items: center; gap: 0.5rem; }
    .gauge-label { font-size: 0.85rem; font-weight: 600; color: #475569; text-transform: uppercase; letter-spacing: 0.05em; }
    .gauge-na { font-size: 1.2rem; color: #94a3b8; margin-top: 1rem; }
    .gauge-svg { display: block; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 1.5rem; font-size: 0.875rem; }
    th { background: #f1f5f9; text-align: left; padding: 0.6rem 0.75rem; font-weight: 600; color: #475569; border-bottom: 2px solid #e2e8f0; }
    td { padding: 0.5rem 0.75rem; border-bottom: 1px solid #f1f5f9; }
    tr:hover td { background: #f8fafc; }
    .num { text-align: right; font-variant-numeric: tabular-nums; }
    .good { color: #16a34a; font-weight: 600; }
    .warn { color: #ca8a04; font-weight: 600; }
    .bad  { color: #dc2626; font-weight: 600; }
    .ok   { color: #16a34a; }
    .fail { color: #dc2626; }
    .skip { color: #ca8a04; }
    .missing { color: #94a3b8; font-style: italic; padding: 0.5rem 0; }
    .card { background: white; border-radius: 0.75rem; box-shadow: 0 1px 3px rgba(0,0,0,0.07); padding: 1.5rem; margin-bottom: 1.5rem; }
    footer { margin-top: 2rem; font-size: 0.75rem; color: #94a3b8; }
  </style>
</head>
<body>
  <h1>BSV SDK Conformance Dashboard</h1>
  <p class="subtitle">Generated at ${htmlEscape(generatedAt)}</p>

  <div class="card">
    <h2>Pass Rate Overview</h2>
    <div class="gauges">
      ${gauge(goReport?.pass_rate ?? null, "Go Runner")}
      ${gauge(tsReport?.pass_rate ?? null, "TS Runner")}
    </div>

    <h3>Summary</h3>
    <table>
      <thead>
        <tr>
          <th>Runner</th>
          <th>Pass Rate</th>
          <th class="num">Passed</th>
          <th class="num">Failed</th>
          <th class="num">Skipped</th>
          <th class="num">Total</th>
          <th>Generated At</th>
        </tr>
      </thead>
      <tbody>
        ${summaryRow(goReport, "Go")}
        ${summaryRow(tsReport, "TypeScript")}
      </tbody>
    </table>
  </div>

  <div class="card">
    <h2>Per-Category Results</h2>
    ${categoryTable(goReport, "Go Runner")}
    ${categoryTable(tsReport, "TypeScript Runner")}
  </div>

  <footer>
    BSV SDK Conformance Suite &mdash; dashboard generated by
    <code>conformance/runner/scripts/dashboard.mjs</code>
  </footer>
</body>
</html>`;

const outPath = resolve(reportsDir, "dashboard.html");
writeFileSync(outPath, html, "utf8");
console.log(`Dashboard written to ${outPath}`);
