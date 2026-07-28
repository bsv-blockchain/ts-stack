#!/usr/bin/env node
/**
 * Generate deterministic, self-contained HTML references for the repository's
 * AsyncAPI specifications. The renderer intentionally uses only the maintained
 * `yaml` parser so documentation builds do not inherit a package generator,
 * template engine, browser runtime, or their legacy parser chains.
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { inspect } from 'node:util'
import { parse } from 'yaml'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const SPECS = [
  {
    spec: 'specs/payments/brc29-payment-protocol.yaml',
    out: 'docs-site/public/assets/asyncapi/brc29'
  },
  {
    spec: 'specs/auth/brc103-mutual-auth.yaml',
    out: 'docs-site/public/assets/asyncapi/brc31'
  },
  {
    spec: 'specs/messaging/authsocket-asyncapi.yaml',
    out: 'docs-site/public/assets/asyncapi/authsocket'
  },
  {
    spec: 'specs/sync/gasp-asyncapi.yaml',
    out: 'docs-site/public/assets/asyncapi/gasp'
  }
]

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('\n', '&#10;')
}

function identifier(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
}

function description(value) {
  if (value == null || value === '') return ''
  return `<div class="description">${escapeHtml(value)}</div>`
}

function scalar(value) {
  if (value === null) return '<span class="value null">null</span>'
  if (typeof value === 'string') {
    const className = value.startsWith('#/') ? 'ref' : 'string'
    return `<code class="value ${className}">${escapeHtml(value)}</code>`
  }
  return `<code class="value">${escapeHtml(JSON.stringify(value))}</code>`
}

function collectionSummary(value) {
  if (Array.isArray(value)) {
    const suffix = value.length === 1 ? '' : 's'
    return `${value.length} item${suffix}`
  }

  const count = Object.keys(value).length
  const suffix = count === 1 ? '' : 's'
  return `${count} field${suffix}`
}

function renderValue(value, depth = 0) {
  if (value == null || typeof value !== 'object') return scalar(value)

  if (Array.isArray(value)) {
    if (value.length === 0) return '<span class="muted">empty list</span>'
    const items = value.map(item => '<li>' + renderValue(item, depth + 1) + '</li>').join('')
    return `<ol class="tree-list">${items}</ol>`
  }

  const entries = Object.entries(value)
  if (entries.length === 0) return '<span class="muted">empty object</span>'

  return `<dl class="tree">${entries
    .map(([key, child]) => {
      const nested = child != null && typeof child === 'object'
      if (!nested) {
        return `<div class="tree-row"><dt>${escapeHtml(key)}</dt><dd>${scalar(child)}</dd></div>`
      }

      const open = depth < 1 ? ' open' : ''
      const summary = collectionSummary(child)
      const renderedChild = renderValue(child, depth + 1)
      return `<div class="tree-row nested"><dt>${escapeHtml(key)}</dt><dd><details${open}><summary>${summary}</summary>${renderedChild}</details></dd></div>`
    })
    .join('')}</dl>`
}

function renderEntries(title, sectionId, entries, renderSummary) {
  const values = Object.entries(entries ?? {})
  if (values.length === 0) return ''

  return `<section id="${sectionId}">
    <div class="section-heading"><h2>${escapeHtml(title)}</h2><span>${values.length}</span></div>
    <div class="cards">${values
      .map(([name, value]) => {
        const summary = renderSummary?.(value) ?? ''
        return `<article class="card" id="${sectionId}-${identifier(name)}">
        <h3>${escapeHtml(name)}</h3>
        ${summary}
        ${description(value?.description ?? value?.summary)}
        ${renderValue(value)}
      </article>`
      })
      .join('')}</div>
  </section>`
}

function renderSpec(document, source, specPath) {
  const info = document.info
  const components = document.components ?? {}
  const counts = [
    ['Servers', Object.keys(document.servers ?? {}).length],
    ['Channels', Object.keys(document.channels ?? {}).length],
    ['Operations', Object.keys(document.operations ?? {}).length],
    ['Messages', Object.keys(components.messages ?? {}).length],
    ['Schemas', Object.keys(components.schemas ?? {}).length]
  ]

  const nav = counts
    .filter(([, count]) => count > 0)
    .map(([name]) => `<a href="#${name.toLowerCase()}">${name}</a>`)
    .join('')

  const body = [
    renderEntries('Servers', 'servers', document.servers, server => {
      const endpoint = [server.protocol, server.host].filter(Boolean).join('://')
      return endpoint === ''
        ? ''
        : `<p class="endpoint">${escapeHtml(endpoint)}${escapeHtml(server.pathname ?? '')}</p>`
    }),
    renderEntries('Channels', 'channels', document.channels, channel => {
      return channel.address == null ? '' : `<p class="endpoint">${escapeHtml(channel.address)}</p>`
    }),
    renderEntries('Operations', 'operations', document.operations, operation => {
      return operation.action == null
        ? ''
        : `<span class="badge">${escapeHtml(operation.action)}</span>`
    }),
    renderEntries('Messages', 'messages', components.messages),
    renderEntries('Schemas', 'schemas', components.schemas)
  ].join('')

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>${escapeHtml(info.title)} · AsyncAPI</title>
  <style>
    :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e8edf7;background:#0c0d14;font-synthesis:none}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 20% 0,#17213b 0,transparent 32rem),#0c0d14;color:#e8edf7}
    a{color:#8dc5ff;text-decoration:none}a:hover{text-decoration:underline}code,pre{font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace}
    header{padding:3.5rem max(1.25rem,calc((100vw - 1120px)/2));border-bottom:1px solid #283149;background:#0c0d14cc}
    .eyebrow{color:#84aef2;font-size:.78rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase}.title-row{display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
    h1{font-size:clamp(2rem,5vw,3.7rem);line-height:1.03;margin:.65rem 0}.version,.badge{display:inline-block;border:1px solid #44659a;border-radius:999px;padding:.28rem .62rem;color:#acd0ff;background:#14213a;font-size:.78rem;font-weight:700}
    .lede{max-width:78ch;white-space:pre-wrap;color:#bac5d8;line-height:1.65}.metrics{display:flex;gap:.65rem;flex-wrap:wrap;margin-top:1.4rem}.metric{border:1px solid #2c3852;background:#121724;border-radius:.7rem;padding:.55rem .75rem}.metric strong{margin-right:.3rem}
    nav{position:sticky;top:0;z-index:4;display:flex;gap:.35rem;overflow:auto;padding:.7rem max(1.25rem,calc((100vw - 1120px)/2));border-bottom:1px solid #283149;background:#0c0d14ed;backdrop-filter:blur(12px)}
    nav a{padding:.42rem .7rem;border-radius:.5rem;color:#c9d6e9;font-size:.9rem}nav a:hover{background:#1a2335;text-decoration:none}
    main{max-width:1120px;margin:auto;padding:1.5rem 1.25rem 5rem}section{scroll-margin-top:4rem;margin-top:2.4rem}.section-heading{display:flex;align-items:center;gap:.75rem;border-bottom:1px solid #2a344b;margin-bottom:1rem}.section-heading h2{font-size:1.55rem}.section-heading span{color:#8290a6}
    .cards{display:grid;gap:1rem}.card{border:1px solid #2a344b;background:#111621;border-radius:.85rem;padding:1.1rem;box-shadow:0 16px 45px #0003}.card h3{margin:.1rem 0 .8rem;color:#f4f7fc}.description{white-space:pre-wrap;color:#b9c5d8;line-height:1.55;margin:.6rem 0 1rem}.endpoint{color:#8bd5ca;font-family:"SFMono-Regular",Consolas,monospace}
    .tree{margin:.6rem 0}.tree-row{display:grid;grid-template-columns:minmax(9rem,22%) 1fr;border-top:1px solid #232d42;padding:.52rem 0;gap:.7rem}.tree-row:first-child{border-top:0}.tree dt{color:#9eb7de;font-weight:650;overflow-wrap:anywhere}.tree dd{margin:0;min-width:0}.tree-row.nested>dd>details>summary{color:#8290a6;cursor:pointer}.tree-list{margin:.4rem 0;padding-left:1.5rem}.tree-list li{margin:.35rem 0}
    .value{white-space:pre-wrap;overflow-wrap:anywhere;color:#d8e4f5}.value.string{color:#a5d6a7}.value.ref{color:#90caf9}.value.null,.muted{color:#7e8ba1}
    details.raw{margin-top:3rem;border:1px solid #2a344b;border-radius:.8rem;background:#101520}details.raw>summary{cursor:pointer;padding:1rem;font-weight:700}.raw pre{margin:0;padding:1rem;overflow:auto;border-top:1px solid #2a344b;color:#c9d6e9;line-height:1.5;font-size:.82rem}
    footer{max-width:1120px;margin:auto;padding:0 1.25rem 3rem;color:#7f8ba0;font-size:.85rem}
    @media(max-width:680px){header{padding-top:2rem}.tree-row{grid-template-columns:1fr}.tree dd{padding-left:.35rem}}
  </style>
</head>
<body>
  <header>
    <div class="eyebrow">AsyncAPI ${escapeHtml(document.asyncapi)} · ${escapeHtml(specPath)}</div>
    <div class="title-row"><h1>${escapeHtml(info.title)}</h1><span class="version">v${escapeHtml(info.version)}</span></div>
    ${description(info.description)}
    <div class="metrics">${counts.map(([name, count]) => `<span class="metric"><strong>${count}</strong>${name}</span>`).join('')}</div>
  </header>
  <nav aria-label="Specification sections">${nav}<a href="#raw-source">Raw source</a></nav>
  <main>
    ${body}
    <details class="raw" id="raw-source">
      <summary>Raw YAML source</summary>
      <pre>${escapeHtml(source)}</pre>
    </details>
  </main>
  <footer>Generated deterministically from the repository source. No remote scripts, styles, fonts, or runtime dependencies.</footer>
</body>
</html>
`
    .split('\n')
    .map(line => line.trim())
    .join('')
}

function validate(document, specPath) {
  if (document == null || typeof document !== 'object') {
    throw new TypeError(`${specPath} must contain a YAML object`)
  }
  if (typeof document.asyncapi !== 'string' || !document.asyncapi.startsWith('3.')) {
    throw new TypeError(`${specPath} must declare AsyncAPI 3.x`)
  }
  if (typeof document.info?.title !== 'string' || typeof document.info?.version !== 'string') {
    throw new TypeError(`${specPath} must declare info.title and info.version`)
  }
}

let failures = 0
for (const { spec, out } of SPECS) {
  try {
    const source = readFileSync(resolve(ROOT, spec), 'utf8')
      .split('\n')
      .map(line => line.trimEnd())
      .join('\n')
    const document = parse(source, { prettyErrors: true, uniqueKeys: true })
    validate(document, spec)

    const outputDirectory = resolve(ROOT, out)
    mkdirSync(outputDirectory, { recursive: true })
    writeFileSync(resolve(outputDirectory, 'index.html'), renderSpec(document, source, spec))
    console.log(`generated ${out}/index.html`)
  } catch (error) {
    failures += 1
    console.error(`failed ${spec}: ${error instanceof Error ? error.message : inspect(error)}`)
  }
}

if (failures > 0) process.exit(1)
console.log(`AsyncAPI HTML generation complete: ${SPECS.length} succeeded, 0 failed.`)
