import { configSchema, type ConfigSchema } from '../config/schema.js'
import { listCapabilities } from '../registry.js'
import { remainingCapabilityIds, type ProjectManifest } from '../config/project-manifest.js'
export function serializeSchema(existing: ProjectManifest | null): ConfigSchema {
  const allIds = listCapabilities().map(c => c.id)
  const defaultIds = new Set(
    listCapabilities()
      .filter(c => c.defaultSelected === true)
      .map(c => c.id)
  )
  const offerable =
    existing === null
      ? allIds.filter(id => !defaultIds.has(id))
      : remainingCapabilityIds(existing, allIds)
  return configSchema.map(section => ({
    ...section,
    fields: section.fields.map(field => {
      if (field.key !== 'capabilities') return { ...field }
      const options = (field.options ?? []).filter(o => offerable.includes(o.value))
      return { ...field, options }
    })
  }))
}

const STYLES = `:root { --accent: #2196F3; }
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: #0b0e13; color: #cdd4de; font: 14px/1.5 system-ui, -apple-system, sans-serif; }

.app { display: flex; height: 100vh; min-height: 600px; overflow: hidden; position: relative; }

/* ---- sidebar ---- */
.side { width: 244px; flex: 0 0 auto; background: #090c11; border-right: 1px solid #1b222b; padding: 20px 14px 16px; display: flex; flex-direction: column; }
.brand { display: flex; align-items: center; gap: 10px; padding: 0 8px 20px; }
.brand svg, .brand .logo { width: 24px; height: 24px; display: block; }
.brand span { font-weight: 600; font-size: 15px; color: #e8edf4; }
#nav { display: flex; flex-direction: column; gap: 4px; }
.nav-item { display: flex; align-items: center; gap: 11px; width: 100%; text-align: left; padding: 9px 10px; border-radius: 7px; border: 0; background: transparent; color: #7b8694; font: 500 13px/1 system-ui; cursor: pointer; }
.nav-item .ic { width: 19px; height: 19px; border-radius: 5px; border: 1px solid #2c3540; color: #6b7480; font: 600 11px/17px system-ui; text-align: center; flex: 0 0 auto; }
.nav-item.done { background: #11202e; color: #cfe0ee; }
.nav-item.done .ic { background: var(--accent); border-color: var(--accent); color: #06121f; line-height: 19px; }
.nav-item.active { border: 1px solid var(--accent); background: rgba(33,150,243,.08); color: #fff; font-weight: 600; }
.nav-item.active .ic { border-color: var(--accent); color: var(--accent); }
.prog { margin-top: auto; padding: 0 8px; }
.prog-bar { height: 4px; border-radius: 2px; background: #1a222b; overflow: hidden; margin-bottom: 9px; }
#progFill { height: 100%; background: var(--accent); border-radius: 2px; transition: width .2s; }
#progLabel { font: 400 11px/1.4 system-ui; color: #4a525d; }

/* ---- form ---- */
.main { flex: 1; min-width: 0; overflow-y: auto; padding: 38px 44px; }
.main-inner { max-width: 540px; }
.sec-title { font: 600 22px/1.1 system-ui; color: #e8edf4; margin-bottom: 5px; }
.sec-desc { font: 400 13px/1.5 system-ui; color: #7b8694; margin-bottom: 30px; }
.field { margin-bottom: 24px; }
.field-label { display: block; font: 500 12px/1 system-ui; color: #aab3bf; margin-bottom: 9px; }
.input { width: 100%; height: 40px; padding: 0 13px; border: 1px solid #2c3540; border-radius: 7px; background: #0f151c; color: #cdd4de; font: 400 13px/1 "JetBrains Mono", ui-monospace, monospace; outline: none; }
.input:focus { border-color: var(--accent); }
.select { width: 100%; height: 40px; padding: 0 11px; border: 1px solid #2c3540; border-radius: 7px; background: #0f151c; color: #cdd4de; color-scheme: dark; font: 400 13px/1 system-ui; outline: none; cursor: pointer; }
.select:focus { border-color: var(--accent); }
.seg { display: flex; gap: 7px; }
.seg-btn { flex: 1; height: 40px; border-radius: 7px; border: 1px solid #2c3540; background: transparent; color: #9aa3af; font: 500 12px/1 system-ui; cursor: pointer; }
.seg-btn:hover { border-color: #3d4855; color: #cdd4de; }
.seg-btn.on { border-color: var(--accent); background: var(--accent); color: #06121f; font-weight: 600; }
.toggle-row { display: flex; align-items: center; gap: 13px; }
.switch { width: 46px; height: 26px; border-radius: 13px; border: 0; background: #2c3540; position: relative; cursor: pointer; flex: 0 0 auto; }
.switch .knob { position: absolute; top: 3px; left: 3px; width: 20px; height: 20px; border-radius: 50%; background: #5a636e; transition: .15s; }
.switch.on { background: var(--accent); }
.switch.on .knob { left: 23px; background: #06121f; }
.toggle-state { font: 400 12px/1 system-ui; color: #7b8694; }
.opt-card { display: flex; gap: 11px; align-items: flex-start; width: 100%; text-align: left; border: 1px solid #243441; background: #0f151c; border-radius: 9px; padding: 13px; cursor: pointer; margin-bottom: 8px; }
.opt-card .box { width: 19px; height: 19px; border-radius: 5px; border: 1px solid #2c3540; flex: 0 0 auto; }
.opt-card.on .box { background: var(--accent); border-color: var(--accent); color: #06121f; font: 600 11px/19px system-ui; text-align: center; }
.opt-card .ot { font: 500 13px/1.3 system-ui; color: #cdd4de; }
.opt-card .oh { display: block; font: 400 11px/1.45 system-ui; color: #6b7480; margin-top: 4px; }

/* ---- command rail ---- */
.rail { width: 420px; flex: 0 0 auto; background: #070a0e; border-left: 1px solid #1b222b; padding: 26px; display: flex; flex-direction: column; overflow-y: auto; }
.label { font: 600 10px/1 system-ui; letter-spacing: .14em; color: #6b7480; text-transform: uppercase; margin-bottom: 11px; }
.term { background: #05070a; border: 1px solid #243441; border-radius: 8px; padding: 14px; font: 400 12px/1.75 "JetBrains Mono", ui-monospace, monospace; white-space: pre-wrap; word-break: break-word; margin-bottom: 18px; }
.term .prompt { color: var(--accent); }
.chips { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 18px; }
.chip { font: 400 11px/1 system-ui; color: #9fb4c9; background: #11202e; border: 1px solid #1c3346; border-radius: 20px; padding: 6px 10px; }
.impact { border-top: 1px solid #161d25; padding-top: 15px; }
.impact-head { width: 100%; display: flex; align-items: center; justify-content: space-between; background: transparent; border: 0; padding: 3px 0; cursor: pointer; }
.impact-head .ht { display: flex; align-items: center; gap: 8px; font: 600 10px/1 system-ui; letter-spacing: .14em; color: #9aa6b2; text-transform: uppercase; }
.impact-head .chev { font-size: 9px; color: #6b7480; }
.impact-head.open .chev { color: var(--accent); }
.impact-head .cnt { font: 500 10px/1 system-ui; color: #5a636e; }
.impact-head .cnt b { color: #7fd6a0; font-weight: 500; }
.impact-body { margin-top: 13px; }
.impact-note { font: 400 11px/1.5 system-ui; color: #6b7480; margin-bottom: 11px; }
.view-toggle { display: flex; justify-content: flex-end; margin-bottom: 11px; }
.vt { display: flex; border: 1px solid #2c3540; border-radius: 6px; overflow: hidden; }
.vt button { background: transparent; color: #7b8694; font: 500 10px/1 system-ui; padding: 6px 11px; border: 0; cursor: pointer; }
.vt button + button { border-left: 1px solid #2c3540; }
.vt button.on { background: var(--accent); color: #06121f; font-weight: 600; }
.tree { background: #05070a; border: 1px solid #1d242d; border-radius: 7px; padding: 13px; }
.tree-line { white-space: pre; font: 400 11px/1.85 "JetBrains Mono", ui-monospace, monospace; }
.tree-line .pfx { color: #566373; }
.flist { background: #05070a; border: 1px solid #1d242d; border-radius: 7px; padding: 11px 13px; display: flex; flex-direction: column; gap: 4px; }
.frow { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.frow .fp { font: 400 11px/1.9 "JetBrains Mono", ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { font: 600 9px/1 system-ui; border-radius: 4px; padding: 3px 5px; flex: 0 0 auto; }
.badge.new { color: #7fd6a0; background: #0f2418; border: 1px solid #1d3d28; }
.badge.edit { color: #e0b25a; background: #241d0f; border: 1px solid #3d3219; }
.actions { margin-top: auto; padding-top: 18px; display: flex; flex-direction: column; gap: 9px; }
.err { color: #e06a5a; font: 400 12px/1.4 system-ui; min-height: 16px; }
.btn { height: 40px; border: 1px solid #2c3540; border-radius: 7px; background: transparent; color: #aab3bf; font: 500 13px/1 system-ui; cursor: pointer; }
.btn:hover { border-color: #3d4855; color: #cdd4de; }
.btn-primary { height: 44px; border: 0; border-radius: 7px; background: var(--accent); color: #06121f; font: 600 14px/1 system-ui; cursor: pointer; }

/* ---- done overlay ---- */
.overlay { position: fixed; inset: 0; background: rgba(4,6,9,.88); display: flex; align-items: center; justify-content: center; z-index: 50; }
.overlay .card { background: #0e141b; border: 1px solid #243441; border-radius: 14px; padding: 36px 40px; max-width: 390px; text-align: center; box-shadow: 0 24px 70px rgba(0,0,0,.55); }
.overlay .ok { width: 54px; height: 54px; border-radius: 50%; background: var(--accent); color: #06121f; font: 600 27px/54px system-ui; margin: 0 auto 18px; }
.overlay h2 { font: 600 19px/1.2 system-ui; color: #e8edf4; margin: 0 0 9px; }
.overlay p { font: 400 13px/1.6 system-ui; color: #8b95a0; margin: 0 0 24px; }
`

const LOGO_SVG =
  '<svg id="logo-svg" width="450" height="450" viewBox="0 0 450 450" xmlns="http://www.w3.org/2000/svg"><line x1="405" y1="225" x2="352.27922061357856" y2="352.27922061357856" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="405" y1="225" x2="225" y2="405" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="405" y1="225" x2="97.72077938642146" y2="352.27922061357856" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="405" y1="225" x2="97.72077938642141" y2="97.72077938642146" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="405" y1="225" x2="224.99999999999997" y2="45" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="405" y1="225" x2="352.2792206135785" y2="97.72077938642141" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="352.27922061357856" y1="352.27922061357856" x2="225" y2="405" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="352.27922061357856" y1="352.27922061357856" x2="97.72077938642146" y2="352.27922061357856" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="352.27922061357856" y1="352.27922061357856" x2="45" y2="225.00000000000003" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="352.27922061357856" y1="352.27922061357856" x2="97.72077938642141" y2="97.72077938642146" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="352.27922061357856" y1="352.27922061357856" x2="224.99999999999997" y2="45" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="352.27922061357856" y1="352.27922061357856" x2="352.2792206135785" y2="97.72077938642141" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="225" y1="405" x2="97.72077938642146" y2="352.27922061357856" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="225" y1="405" x2="45" y2="225.00000000000003" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="225" y1="405" x2="97.72077938642141" y2="97.72077938642146" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="225" y1="405" x2="352.2792206135785" y2="97.72077938642141" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="97.72077938642146" y1="352.27922061357856" x2="45" y2="225.00000000000003" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="97.72077938642146" y1="352.27922061357856" x2="97.72077938642141" y2="97.72077938642146" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="97.72077938642146" y1="352.27922061357856" x2="224.99999999999997" y2="45" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="97.72077938642146" y1="352.27922061357856" x2="352.2792206135785" y2="97.72077938642141" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="45" y1="225.00000000000003" x2="97.72077938642141" y2="97.72077938642146" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="45" y1="225.00000000000003" x2="224.99999999999997" y2="45" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="45" y1="225.00000000000003" x2="352.2792206135785" y2="97.72077938642141" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="97.72077938642141" y1="97.72077938642146" x2="224.99999999999997" y2="45" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="97.72077938642141" y1="97.72077938642146" x2="352.2792206135785" y2="97.72077938642141" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><line x1="224.99999999999997" y1="45" x2="352.2792206135785" y2="97.72077938642141" stroke="#2196F3" stroke-opacity="1" stroke-width="2"></line><circle cx="405" cy="225" r="8" fill="#2196F3"></circle><circle cx="352.27922061357856" cy="352.27922061357856" r="8" fill="#2196F3"></circle><circle cx="225" cy="405" r="8" fill="#2196F3"></circle><circle cx="97.72077938642146" cy="352.27922061357856" r="8" fill="#2196F3"></circle><circle cx="45" cy="225.00000000000003" r="8" fill="#2196F3"></circle><circle cx="97.72077938642141" cy="97.72077938642146" r="8" fill="#2196F3"></circle><circle cx="224.99999999999997" cy="45" r="8" fill="#2196F3"></circle><circle cx="352.2792206135785" cy="97.72077938642141" r="8" fill="#2196F3"></circle></svg>'

const CLIENT_SCRIPT = String.raw`/* create-bsv-app --ui : schema-driven static page (no dependencies).
 * Reads window.__SCHEMA__ / __SEED__ / __INCLUDED__ and POSTs the draft to /generate.
 * Optional globals: __ACCENT__ (hex), __CMD_LABEL__ (string), __DEMO__ (bool, skips server). */
(function () {
  var SCHEMA = window.__SCHEMA__ || [];
  var SEED = window.__SEED__ || {};
  var INCLUDED = window.__INCLUDED__ || [{ label: '@bsv/sdk' }, { label: 'AGENTS.md' }];
  var ACCENT = window.__ACCENT__ || '#2196F3';
  var CMD_LABEL = window.__CMD_LABEL__ || 'Your command';

  document.documentElement.style.setProperty('--accent', ACCENT);

  /* RECONCILIATION 2: active uses s.id, falls back to first visible section id */
  function visibleSections() {
    return SCHEMA.filter(function (s) {
      return (s.fields || []).some(function (f) { return whenOk(f.when); });
    });
  }

  var state = {
    active: (SCHEMA[0] || {}).id,
    impactOpen: true,
    impactView: 'tree',
    copied: false,
    generating: false,
    error: '',
    ov: null,
    plan: []
  };

  var draft = {};
  for (var si = 0; si < SCHEMA.length; si++) {
    var fs = SCHEMA[si].fields || [];
    for (var fi = 0; fi < fs.length; fi++) {
      var f = fs[fi];
      if (SEED[f.key] !== undefined) draft[f.key] = SEED[f.key];
      else if (f.type === 'multiselect') draft[f.key] = Array.isArray(f.default) ? f.default.slice() : [];
      else if (f.default !== undefined) draft[f.key] = f.default;
    }
  }

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    attrs = attrs || {};
    for (var k in attrs) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'class') n.className = v;
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n[k.toLowerCase()] = v;
      else n.setAttribute(k, v);
    }
    (kids || []).forEach(function (c) {
      if (c == null) return;
      n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return n;
  }

  function whenOk(when) {
    if (!when) return true;
    return Object.keys(when).every(function (k) {
      return Array.isArray(when[k]) ? when[k].indexOf(String(draft[k])) !== -1 : draft[k] === when[k];
    });
  }

  /* ---- command ---- */
  function buildCommand(d) {
    var p = ['npx create-bsv-app', '--mode', d.mode || 'new'];
    if ((d.mode || 'new') === 'new') {
      if (d.name) p.push('--name', JSON.stringify(d.name));
      if (d.starter) p.push('--starter', d.starter);
      if (d.frontend && d.frontend !== 'none') p.push('--frontend', d.frontend);
      if (d.frontend === 'react' && d.frontendVariant) p.push('--variant', d.frontendVariant);
      if (d.backend && d.backend !== 'none') p.push('--backend', d.backend);
      if (d.bsvDir) p.push('--bsv-dir', d.bsvDir);
      if (d.packageManager) p.push('--package-manager', d.packageManager);
      if (d.network) p.push('--network', d.network);
      if (d.install === false) p.push('--skip-install');
      /* RECONCILIATION 4: glue defaults on — emit --no-glue only when explicitly false in new mode */
      if ((d.mode || 'new') === 'new' && d.glue === false) p.push('--no-glue');
    }
    if (d.capabilities && d.capabilities.length) p.push('--capabilities', d.capabilities.join(','));
    p.push('--yes');
    return p.join(' ');
  }

  function buildTokens(d) {
    var FLAG = '#7fd6a0', VAL = '#c8d0da', STR = '#e0b25a';
    var t = [{ t: 'npx create-bsv-app', c: VAL }];
    function flag(f, v, col) { t.push({ t: ' ' + f + ' ', c: FLAG }); if (v !== undefined) t.push({ t: v, c: col || VAL }); }
    flag('--mode', d.mode || 'new');
    if ((d.mode || 'new') === 'new') {
      if (d.name) flag('--name', '"' + d.name + '"', STR);
      if (d.starter) flag('--starter', d.starter);
      if (d.frontend && d.frontend !== 'none') flag('--frontend', d.frontend);
      if (d.frontend === 'react' && d.frontendVariant) flag('--variant', d.frontendVariant);
      if (d.backend && d.backend !== 'none') flag('--backend', d.backend);
      if (d.bsvDir) flag('--bsv-dir', d.bsvDir);
      if (d.packageManager) flag('--package-manager', d.packageManager);
      if (d.network) flag('--network', d.network);
      if (d.install === false) flag('--skip-install');
      /* RECONCILIATION 4: glue defaults on — emit --no-glue only when explicitly false in new mode */
      if ((d.mode || 'new') === 'new' && d.glue === false) flag('--no-glue');
    }
    if (d.capabilities && d.capabilities.length) flag('--capabilities', d.capabilities.join(','));
    flag('--yes');
    return t;
  }

  /* RECONCILIATION 3: real impact via /plan — computeFiles() deleted */
  var planTimer = null;
  function fetchPlan() {
    if (window.__DEMO__) { state.plan = []; return; }
    clearTimeout(planTimer);
    planTimer = setTimeout(function () {
      fetch('/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) })
        .then(function (r) { return r.json(); })
        .then(function (d) { state.plan = (d && d.files) || []; renderRail(); })
        .catch(function () { state.plan = []; renderRail(); });
    }, 150);
  }

  function buildTree(files, projectName) {
    var root = {};
    files.forEach(function (file) {
      var parts = file.path.split('/');
      var cur = root;
      parts.forEach(function (p, i) {
        /* RECONCILIATION 3: read file.status (not file.st) */
        if (i === parts.length - 1) cur[p] = { __file: true, status: file.status };
        else { if (!cur[p] || cur[p].__file) cur[p] = {}; cur = cur[p]; }
      });
    });
    var lines = [{ prefix: '', name: projectName + '/', color: '#cfe0ee' }];
    (function walk(node, prefix) {
      var keys = Object.keys(node).sort(function (a, b) {
        var ad = !node[a].__file, bd = !node[b].__file;
        if (ad !== bd) return ad ? -1 : 1;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      keys.forEach(function (k, i) {
        var last = i === keys.length - 1;
        var child = node[k];
        var isFile = !!child.__file;
        var conn = last ? '\u2514\u2500 ' : '\u251c\u2500 ';
        /* RECONCILIATION 3: read child.status (not child.st) */
        var color = isFile ? (child.status === 'edit' ? '#e0b25a' : '#7fd6a0') : '#cfe0ee';
        lines.push({ prefix: prefix + conn, name: isFile ? k : k + '/', color: color });
        if (!isFile) walk(child, prefix + (last ? '   ' : '\u2502  '));
      });
    })(root, '');
    return lines;
  }

  /* ---- field controls ---- */
  function fieldControl(f) {
    if (f.type === 'text') {
      var i = el('input', { class: 'input', type: 'text', value: draft[f.key] || '' });
      i.oninput = function () { draft[f.key] = i.value; renderRail(); fetchPlan(); };
      return i;
    }
    if (f.ui === 'segmented') {
      var seg = el('div', { class: 'seg' });
      (f.options || []).forEach(function (o) {
        var b = el('button', { class: 'seg-btn' + (draft[f.key] === o.value ? ' on' : ''), text: o.label });
        b.onclick = function () { draft[f.key] = o.value; renderForm(); renderRail(); fetchPlan(); };
        seg.appendChild(b);
      });
      return seg;
    }
    if (f.type === 'select') {
      var s = el('select', { class: 'select' });
      (f.options || []).forEach(function (o) {
        var opt = el('option', { value: o.value, text: o.label });
        if (draft[f.key] === o.value) opt.selected = true;
        s.appendChild(opt);
      });
      if (draft[f.key] === undefined && f.options && f.options.length) draft[f.key] = f.options[0].value;
      s.onchange = function () { draft[f.key] = s.value; renderForm(); renderRail(); fetchPlan(); };
      return s;
    }
    if (f.type === 'toggle') {
      var row = el('div', { class: 'toggle-row' });
      var sw = el('button', { class: 'switch' + (draft[f.key] ? ' on' : '') }, [el('span', { class: 'knob' })]);
      sw.onclick = function () { draft[f.key] = !draft[f.key]; renderForm(); renderRail(); fetchPlan(); };
      row.appendChild(sw);
      row.appendChild(el('span', { class: 'toggle-state', text: draft[f.key] ? 'Enabled' : 'Disabled' }));
      return row;
    }
    // multiselect
    var box = el('div');
    (f.options || []).forEach(function (o) {
      var on = (draft[f.key] || []).indexOf(o.value) !== -1;
      var txt = el('span', {}, [el('span', { class: 'ot', text: o.label })]);
      if (o.hint) txt.appendChild(el('span', { class: 'oh', text: o.hint }));
      var card = el('button', { class: 'opt-card' + (on ? ' on' : '') }, [el('span', { class: 'box', text: on ? '\u2713' : '' }), txt]);
      card.onclick = function () {
        var set = {};
        (draft[f.key] || []).forEach(function (v) { set[v] = true; });
        if (set[o.value]) delete set[o.value]; else set[o.value] = true;
        draft[f.key] = Object.keys(set);
        renderForm(); renderRail(); fetchPlan();
      };
      box.appendChild(card);
    });
    return box;
  }

  /* ---- renderers ---- */
  /* RECONCILIATION 1+2: use s.id; RECONCILIATION 2: use visibleSections() */
  function activeIndex() {
    var vs = visibleSections();
    var idx = vs.map(function (s) { return s.id; }).indexOf(state.active);
    return Math.max(0, idx);
  }

  function renderNav() {
    var nav = document.getElementById('nav');
    nav.innerHTML = '';
    var vs = visibleSections();
    var ai = activeIndex();
    /* RECONCILIATION 2: ensure state.active is always a visible section */
    if (ai === 0 && vs.length > 0 && vs[0].id !== state.active) {
      state.active = vs[0].id;
    }
    vs.forEach(function (s, i) {
      var cls = i < ai ? 'done' : (i === ai ? 'active' : 'todo');
      /* RECONCILIATION 1: use s.id for navigation (was s.key) */
      var b = el('button', { class: 'nav-item ' + cls }, [el('span', { class: 'ic', text: i < ai ? '\u2713' : String(i + 1) }), s.title]);
      b.onclick = function () { state.active = s.id; renderNav(); renderForm(); renderProgress(); };
      nav.appendChild(b);
    });
  }

  function renderProgress() {
    /* RECONCILIATION 2: use visibleSections() */
    var vs = visibleSections();
    var ai = activeIndex(), total = vs.length || 1;
    document.getElementById('progFill').style.width = Math.round(((ai + 1) / total) * 100) + '%';
    document.getElementById('progLabel').textContent = 'Step ' + (ai + 1) + ' of ' + total;
  }

  function renderForm() {
    var wrap = document.getElementById('formWrap');
    wrap.innerHTML = '';
    /* RECONCILIATION 2: use visibleSections(); fall back active to first visible */
    var vs = visibleSections();
    if (vs.length === 0) return;
    var sec = vs[activeIndex()] || vs[0];
    /* RECONCILIATION 2: if active section is no longer visible, snap to first */
    if (!vs.some(function (s) { return s.id === state.active; })) {
      state.active = vs[0].id;
      sec = vs[0];
    }
    if (!sec) return;
    wrap.appendChild(el('div', { class: 'sec-title', text: sec.title }));
    /* RECONCILIATION 1: section description via s.desc */
    wrap.appendChild(el('div', { class: 'sec-desc', text: sec.desc || '' }));
    sec.fields.filter(function (f) { return whenOk(f.when); }).forEach(function (f) {
      var field = el('div', { class: 'field' }, [el('label', { class: 'field-label', text: f.label })]);
      field.appendChild(fieldControl(f));
      wrap.appendChild(field);
    });
  }

  function renderRail() {
    var rail = document.getElementById('rail');
    rail.innerHTML = '';
    rail.appendChild(el('div', { class: 'label', text: CMD_LABEL }));

    var term = el('div', { class: 'term' }, [el('span', { class: 'prompt', text: '$ ' })]);
    buildTokens(draft).forEach(function (tk) { var s = el('span', { text: tk.t }); s.style.color = tk.c; term.appendChild(s); });
    rail.appendChild(term);

    if (INCLUDED.length) {
      rail.appendChild(el('div', { class: 'label', text: 'Always included' }));
      var chips = el('div', { class: 'chips' });
      INCLUDED.forEach(function (c) { chips.appendChild(el('span', { class: 'chip', text: c.label })); });
      rail.appendChild(chips);
    }

    /* RECONCILIATION 3: use state.plan (from /plan) instead of computeFiles() */
    var files = state.plan;
    var newCount = files.filter(function (f) { return f.status === 'new'; }).length;
    var impact = el('div', { class: 'impact' });
    var head = el('button', { class: 'impact-head' + (state.impactOpen ? ' open' : '') });
    head.onclick = function () { state.impactOpen = !state.impactOpen; renderRail(); };
    var ht = el('span', { class: 'ht' }, [el('span', { class: 'chev', text: state.impactOpen ? '\u25be' : '\u25b8' }), 'Project impact']);
    var cnt = el('span', { class: 'cnt' });
    cnt.appendChild(document.createTextNode(files.length + ' \u00b7 '));
    cnt.appendChild(el('b', { text: newCount + ' new' }));
    head.appendChild(ht); head.appendChild(cnt);
    impact.appendChild(head);

    if (state.impactOpen) {
      var body = el('div', { class: 'impact-body' });
      body.appendChild(el('div', { class: 'impact-note', text: 'BSV files create-bsv-app writes — your framework files (Vite/Express) are scaffolded separately.' }));
      var vtg = el('div', { class: 'vt' });
      var tb = el('button', { class: state.impactView === 'tree' ? 'on' : '', text: 'Tree' });
      tb.onclick = function () { state.impactView = 'tree'; renderRail(); };
      var lb = el('button', { class: state.impactView === 'list' ? 'on' : '', text: 'List' });
      lb.onclick = function () { state.impactView = 'list'; renderRail(); };
      vtg.appendChild(tb); vtg.appendChild(lb);
      body.appendChild(el('div', { class: 'view-toggle' }, [vtg]));

      if (state.impactView === 'tree') {
        var tree = el('div', { class: 'tree' });
        buildTree(files, draft.name || 'project').forEach(function (ln) {
          var line = el('div', { class: 'tree-line' }, [el('span', { class: 'pfx', text: ln.prefix })]);
          var nm = el('span', { text: ln.name }); nm.style.color = ln.color; line.appendChild(nm);
          tree.appendChild(line);
        });
        body.appendChild(tree);
      } else {
        var fl = el('div', { class: 'flist' });
        /* RECONCILIATION 3: read f.status (not f.st) */
        files.forEach(function (f) {
          var fp = el('span', { class: 'fp', text: f.path }); fp.style.color = f.status === 'edit' ? '#8b95a0' : '#c2cad4';
          var badge = el('span', { class: 'badge ' + (f.status === 'edit' ? 'edit' : 'new'), text: f.status === 'edit' ? 'EDIT' : 'NEW' });
          fl.appendChild(el('div', { class: 'frow' }, [fp, badge]));
        });
        body.appendChild(fl);
      }
      impact.appendChild(body);
    }
    rail.appendChild(impact);

    var actions = el('div', { class: 'actions' });
    if (state.error) actions.appendChild(el('div', { class: 'err', text: state.error }));
    var copy = el('button', { class: 'btn', text: state.copied ? 'Copied!' : 'Copy command' });
    copy.onclick = copyCmd;
    var gen = el('button', { class: 'btn-primary', text: state.generating ? 'Generating\u2026' : 'Generate' });
    gen.onclick = generate;
    actions.appendChild(copy); actions.appendChild(gen);
    rail.appendChild(actions);
  }

  function copyCmd() {
    try { navigator.clipboard && navigator.clipboard.writeText(buildCommand(draft)); } catch (e) {}
    state.copied = true; renderRail();
    clearTimeout(copyCmd._t);
    copyCmd._t = setTimeout(function () { state.copied = false; renderRail(); }, 1500);
  }

  function generate() {
    state.error = '';
    if (window.__DEMO__) {
      showOverlay(state.plan.map(function (f) { return f.path; }), './' + (draft.name || 'project'));
      return;
    }
    state.generating = true; renderRail();
    fetch('/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(draft) })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
      .then(function (res) {
        state.generating = false;
        if (!res.ok) { state.error = (res.data && res.data.error) || 'Failed'; renderRail(); return; }
        showOverlay(res.data.written || [], res.data.targetDir || '.');
      })
      .catch(function (e) { state.generating = false; state.error = String(e); renderRail(); });
  }

  function showOverlay(written, dir) {
    hideOverlay();
    var host = document.getElementById('overlayHost') || document.body;
    var card = el('div', { class: 'card' }, [
      el('div', { class: 'ok', text: '\u2713' }),
      el('h2', { text: 'Project generated' }),
      el('p', { text: 'Wrote ' + written.length + ' file(s) to ' + dir + '. See AGENTS.md for wiring \u2014 you can close this tab.' })
    ]);
    var btn = el('button', { class: 'btn', text: 'Start over' });
    btn.onclick = hideOverlay;
    card.appendChild(btn);
    var ov = el('div', { class: 'overlay' }, [card]);
    host.appendChild(ov);
    state.ov = ov;
  }
  function hideOverlay() {
    if (state.ov && state.ov.parentNode) state.ov.parentNode.removeChild(state.ov);
    state.ov = null;
  }

  renderNav();
  renderForm();
  renderRail();
  renderProgress();
  /* RECONCILIATION 3: initial plan fetch */
  fetchPlan();
})();
`

export function buildPage(opts: {
  schema: unknown
  seed: unknown
  included?: Array<{ label: string }>
  accent?: string
  commandLabel?: string
}): string {
  const data =
    'window.__SCHEMA__ = ' +
    JSON.stringify(opts.schema) +
    ';\n' +
    'window.__SEED__ = ' +
    JSON.stringify(opts.seed) +
    ';\n' +
    'window.__INCLUDED__ = ' +
    JSON.stringify(opts.included ?? []) +
    ';\n' +
    (opts.accent == null ? '' : 'window.__ACCENT__ = ' + JSON.stringify(opts.accent) + ';\n') +
    (opts.commandLabel == null
      ? ''
      : 'window.__CMD_LABEL__ = ' + JSON.stringify(opts.commandLabel) + ';\n')

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>create-bsv-app</title>
<style>${STYLES}</style>
</head>
<body>
<div class="app">
  <aside class="side">
    <div class="brand">${LOGO_SVG}<span>create-bsv-app</span></div>
    <nav id="nav"></nav>
    <div class="prog"><div class="prog-bar"><div id="progFill"></div></div><div id="progLabel"></div></div>
  </aside>
  <main class="main"><div class="main-inner" id="formWrap"></div></main>
  <aside class="rail" id="rail"></aside>
</div>
<div id="overlayHost"></div>
<script>${data}</script>
<script>${CLIENT_SCRIPT}</script>
</body>
</html>`
}
