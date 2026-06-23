import { configSchema, type ConfigSchema } from '../config/schema.js'
import { listCapabilities } from '../registry.js'
import { remainingCapabilityIds, type ProjectManifest } from '../config/project-manifest.js'
import type { ConfigDraft } from '../config/draft.js'

export function serializeSchema (existing: ProjectManifest | null): ConfigSchema {
  const allIds = listCapabilities().map(c => c.id)
  const offerable = existing !== null ? remainingCapabilityIds(existing, allIds) : allIds
  return configSchema.map(section => ({
    ...section,
    fields: section.fields.map(field => {
      if (field.key !== 'capabilities') return { ...field }
      const options = (field.options ?? []).filter(o => offerable.includes(o.value))
      return { ...field, options }
    })
  }))
}

const CLIENT_SCRIPT = `
const SCHEMA = window.__SCHEMA__
const SEED = window.__SEED__
const draft = {}
for (const section of SCHEMA) for (const f of section.fields) {
  if (SEED[f.key] !== undefined) draft[f.key] = SEED[f.key]
  else if (f.type === 'multiselect') draft[f.key] = []
  else if (f.default !== undefined) draft[f.key] = f.default
}
function whenOk (when) {
  if (!when) return true
  return Object.keys(when).every(k => draft[k] === when[k])
}
function el (tag, attrs, kids) {
  const n = document.createElement(tag)
  for (const k in (attrs || {})) {
    if (k === 'text') n.textContent = attrs[k]
    else n.setAttribute(k, attrs[k])
  }
  for (const c of (kids || [])) n.appendChild(c)
  return n
}
function fieldControl (f) {
  if (f.type === 'text') {
    const i = el('input', { type: 'text', value: draft[f.key] || '' })
    // text value never drives field visibility, so update only the command preview --
    // a full refresh() would recreate this input and drop focus on every keystroke.
    i.oninput = () => { draft[f.key] = i.value; updateCommand() }
    return i
  }
  if (f.type === 'toggle') {
    const i = el('input', { type: 'checkbox' })
    i.checked = !!draft[f.key]
    i.onchange = () => { draft[f.key] = i.checked; refresh() }
    return i
  }
  if (f.type === 'select') {
    const s = el('select')
    for (const o of (f.options || [])) {
      const opt = el('option', { value: o.value, text: o.label })
      if (draft[f.key] === o.value) opt.selected = true
      s.appendChild(opt)
    }
    if (draft[f.key] === undefined && f.options && f.options.length) draft[f.key] = f.options[0].value
    s.onchange = () => { draft[f.key] = s.value; refresh() }
    return s
  }
  // multiselect
  const box = el('div', { class: 'multi' })
  for (const o of (f.options || [])) {
    const cb = el('input', { type: 'checkbox', value: o.value })
    cb.checked = (draft[f.key] || []).includes(o.value)
    cb.onchange = () => {
      const set = new Set(draft[f.key] || [])
      if (cb.checked) set.add(o.value); else set.delete(o.value)
      draft[f.key] = Array.from(set); refresh()
    }
    const lbl = el('label', { class: 'opt' }, [cb, el('span', { text: ' ' + o.label + (o.hint ? ' — ' + o.hint : '') })])
    box.appendChild(lbl)
  }
  return box
}
function buildCommand () {
  const d = draft, p = ['npx create-bsv-app', '--mode', d.mode || 'new']
  if ((d.mode || 'new') === 'new') {
    if (d.name) p.push('--name', JSON.stringify(d.name))
    if (d.frontend && d.frontend !== 'none') p.push('--frontend', d.frontend)
    if (d.frontend === 'react' && d.frontendVariant) p.push('--variant', d.frontendVariant)
    if (d.backend && d.backend !== 'none') p.push('--backend', d.backend)
    if (d.bsvDir) p.push('--bsv-dir', d.bsvDir)
    if (d.packageManager) p.push('--package-manager', d.packageManager)
    if (d.network) p.push('--network', d.network)
    if (d.glue) p.push('--glue')
  }
  if (d.capabilities && d.capabilities.length) p.push('--capabilities', d.capabilities.join(','))
  p.push('--yes')
  return p.join(' ')
}
function updateCommand () {
  document.getElementById('command').textContent = buildCommand()
}
function refresh () {
  const root = document.getElementById('form')
  root.innerHTML = ''
  for (const section of SCHEMA) {
    const fields = section.fields.filter(f => whenOk(f.when))
    if (!fields.length) continue
    const body = el('div', { class: 'section-body' })
    for (const f of fields) {
      body.appendChild(el('label', { class: 'field-label', text: f.label }))
      body.appendChild(fieldControl(f))
    }
    root.appendChild(el('fieldset', {}, [el('legend', { text: section.title }), body]))
  }
  updateCommand()
}
async function generate () {
  const btn = document.getElementById('generate')
  btn.disabled = true
  document.getElementById('error').textContent = ''
  try {
    const r = await fetch('/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) })
    const data = await r.json()
    if (!r.ok) { document.getElementById('error').textContent = data.error || 'Failed'; btn.disabled = false; return }
    document.getElementById('app').innerHTML = '<div class="done"><h2>Done</h2><p>Wrote ' + (data.written || []).length + ' BSV file(s) to ' + data.targetDir + '.</p><p>See AGENTS.md for wiring. You can close this tab.</p></div>'
  } catch (e) {
    document.getElementById('error').textContent = String(e); btn.disabled = false
  }
}
document.getElementById('generate').onclick = generate
document.getElementById('copy').onclick = () => navigator.clipboard.writeText(buildCommand())
refresh()
`

export function buildPage (opts: { schema: ConfigSchema, seed: ConfigDraft }): string {
  const data = `window.__SCHEMA__ = ${JSON.stringify(opts.schema)};\nwindow.__SEED__ = ${JSON.stringify(opts.seed)};`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>create-bsv-app</title>
<style>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { font: 15px/1.5 system-ui, sans-serif; max-width: 720px; margin: 0 auto; padding: 24px 16px 140px; }
h1 { font-size: 22px; }
fieldset { border: 1px solid #8884; border-radius: 8px; margin: 0 0 16px; padding: 12px 16px; }
legend { font-weight: 600; padding: 0 6px; }
.section-body { display: grid; gap: 8px; }
.field-label { font-weight: 500; margin-top: 6px; }
input[type=text], select { width: 100%; padding: 6px 8px; border: 1px solid #8886; border-radius: 6px; background: transparent; color: inherit; }
.multi { display: grid; gap: 4px; }
.opt { font-weight: 400; display: flex; align-items: center; gap: 6px; }
footer { position: fixed; left: 0; right: 0; bottom: 0; background: Canvas; border-top: 1px solid #8884; padding: 12px 16px; }
.bar { max-width: 720px; margin: 0 auto; display: flex; gap: 8px; align-items: center; }
#command { flex: 1; font-family: ui-monospace, monospace; font-size: 12px; overflow-x: auto; white-space: nowrap; padding: 8px; border: 1px solid #8884; border-radius: 6px; }
button { padding: 8px 14px; border-radius: 6px; border: 1px solid #8886; cursor: pointer; }
#generate { font-weight: 600; }
#error { color: #c0392b; min-height: 18px; }
.done { padding: 24px; text-align: center; }
</style>
</head>
<body>
<div id="app">
  <h1>create-bsv-app</h1>
  <div id="form"></div>
  <p id="error"></p>
</div>
<footer>
  <div class="bar">
    <code id="command"></code>
    <button id="copy" title="Copy command">Copy</button>
    <button id="generate">Generate</button>
  </div>
</footer>
<script>${data}</script>
<script>${CLIENT_SCRIPT}</script>
</body>
</html>`
}
