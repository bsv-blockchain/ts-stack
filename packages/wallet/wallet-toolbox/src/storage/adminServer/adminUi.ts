export function renderAdminPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Monitor Admin</title>
  <style>
    :root {
      --bg: #f4efe6;
      --panel: #fffaf0;
      --ink: #1f1a14;
      --muted: #6b6257;
      --line: #d9ccb7;
      --accent: #a54b1a;
      --accent-2: #0f766e;
      --warn: #7c2d12;
      --mono: "SFMono-Regular", Menlo, Consolas, monospace;
      --sans: Georgia, "Iowan Old Style", serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        radial-gradient(circle at top left, rgba(165, 75, 26, 0.12), transparent 28rem),
        linear-gradient(180deg, #f8f2e9 0%, var(--bg) 100%);
      color: var(--ink);
      font-family: var(--sans);
    }
    main { width: 100%; padding: 18px; }
    h1, h2, h3 { margin: 0 0 8px; font-weight: 700; }
    h1 { font-size: 1.7rem; line-height: 1.1; }
    h2 { font-size: 1.05rem; }
    p, label, button, input, select, table { font-size: 0.88rem; }
    .subtle { color: var(--muted); }
    .panel {
      background: rgba(255, 250, 240, 0.92);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px;
      box-shadow: 0 10px 28px rgba(59, 36, 14, 0.08);
      backdrop-filter: blur(12px);
    }
    .stack { display: grid; gap: 12px; margin-top: 14px; }
    details.panel {
      padding: 0;
      overflow: hidden;
    }
    details.panel[open] summary { border-bottom: 1px solid var(--line); }
    summary {
      list-style: none;
      cursor: pointer;
      padding: 14px 16px;
      font-size: 1.1rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    summary::-webkit-details-marker { display: none; }
    summary::after {
      content: '+';
      color: var(--accent);
      font-size: 1.1rem;
    }
    details[open] summary::after { content: '−'; }
    .panel-body { padding: 14px; }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: end;
      margin: 8px 0;
    }
    .toolbar label {
      display: flex;
      flex-direction: column;
      gap: 3px;
      min-width: 108px;
    }
    input, select, button, textarea {
      border: 1px solid var(--line);
      border-radius: 9px;
      padding: 6px 8px;
      background: #fffdfa;
      color: var(--ink);
      font-family: inherit;
    }
    button {
      cursor: pointer;
      background: linear-gradient(180deg, #fff7ef, #f2dfca);
      min-height: 31px;
    }
    button.primary {
      background: linear-gradient(180deg, #c5622b, var(--accent));
      color: #fff8f2;
      border-color: #8b3f16;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 6px;
      font-family: var(--mono);
      font-size: 0.75rem;
    }
    th, td {
      border-bottom: 1px solid var(--line);
      text-align: left;
      padding: 6px 5px;
      vertical-align: top;
    }
    th { color: var(--muted); font-weight: 600; }
    pre {
      overflow: auto;
      background: #fff;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 8px;
      font-family: var(--mono);
      font-size: 0.75rem;
      max-height: 320px;
    }
    details { margin-top: 6px; }
    .event-list {
      display: grid;
      gap: 8px;
      margin-top: 8px;
    }
    .event {
      border-left: 4px solid var(--accent-2);
      padding-left: 8px;
    }
    .row-actions {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }
    .notice {
      margin-top: 8px;
      color: var(--warn);
    }
    .stats-table {
      font-family: var(--mono);
      font-size: 0.78rem;
      table-layout: fixed;
      white-space: nowrap;
      width: auto;
      min-width: 0;
    }
    .stats-table th:first-child,
    .stats-table td:first-child {
      position: sticky;
      left: 0;
      background: var(--panel);
    }
    .stats-table th,
    .stats-table td {
      padding-top: 4px;
      padding-bottom: 4px;
    }
    .stats-table thead th {
      color: var(--ink);
      font-weight: 700;
      border-bottom: 2px solid #bda98c;
      background: rgba(242, 223, 202, 0.72);
      box-shadow: inset 0 -1px 0 rgba(139, 63, 22, 0.08);
    }
    .stats-table .stats-head-label,
    .stats-table .stats-label {
      text-align: left;
    }
    .stats-table .stats-head-num,
    .stats-table .stats-num {
      text-align: right;
    }
    .stats-table .stats-subrow {
      color: var(--muted);
    }
    .stats-wrap {
      display: inline-block;
      max-width: 100%;
      overflow-x: auto;
      border: 1px solid rgba(217, 204, 183, 0.75);
      border-radius: 12px;
      background: rgba(255, 253, 250, 0.78);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.65);
    }
    .stats-table .stats-group td {
      padding-top: 6px;
      border-top: 1px solid rgba(165, 75, 26, 0.18);
    }
    .stats-table .stats-group .stats-label {
      font-weight: 700;
      color: var(--ink);
    }
    .stats-table .stats-child .stats-label {
      padding-left: 1.8ch;
      position: relative;
    }
    .stats-table .stats-child .stats-label::before {
      content: '↳';
      position: absolute;
      left: 0.2ch;
      color: #9a8166;
    }
    .pill {
      display: inline-block;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 4px 10px;
      color: var(--muted);
      font-size: 0.78rem;
      background: rgba(255,255,255,0.55);
    }
    .compact-select {
      min-width: 18rem;
      max-width: 100%;
    }
    .wide-input {
      min-width: min(34rem, 100%);
      width: min(34rem, 100%);
      max-width: 100%;
    }
    .mono { font-family: var(--mono); }
    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
      flex-wrap: wrap;
    }
    .service-groups {
      display: grid;
      gap: 12px;
    }
    .service-group {
      border: 1px solid rgba(217, 204, 183, 0.8);
      border-radius: 12px;
      background: rgba(255, 253, 250, 0.72);
      padding: 10px;
    }
    .service-group h3 {
      font-size: 0.96rem;
      margin-bottom: 6px;
    }
    .service-table {
      width: auto;
      min-width: 100%;
      margin-top: 0;
      font-size: 0.73rem;
    }
    .service-table th {
      color: var(--ink);
      font-weight: 700;
      background: rgba(242, 223, 202, 0.62);
      border-bottom: 2px solid #bda98c;
    }
    .service-table th,
    .service-table td {
      padding: 4px 5px;
      vertical-align: top;
    }
    .service-num {
      text-align: right;
      white-space: nowrap;
    }
    .service-list {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      max-width: 54ch;
    }
    .call-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      border-radius: 999px;
      padding: 2px 6px;
      border: 1px solid rgba(217, 204, 183, 0.8);
      background: rgba(255,255,255,0.86);
      white-space: nowrap;
    }
    .call-chip.ok {
      border-color: rgba(15, 118, 110, 0.35);
      background: rgba(15, 118, 110, 0.08);
      color: #0f5e58;
    }
    .call-chip.fail {
      border-color: rgba(165, 75, 26, 0.35);
      background: rgba(165, 75, 26, 0.08);
      color: #8b3f16;
    }
    .service-empty {
      color: var(--muted);
      font-size: 0.8rem;
    }
    .loading-text {
      color: var(--muted);
      font-style: italic;
    }
    .history-nav {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      margin-bottom: 8px;
    }
    .history-buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      align-items: center;
    }
    .history-buttons button {
      min-height: 28px;
      padding: 4px 7px;
      font-size: 0.74rem;
    }
    .history-buttons button.active {
      background: linear-gradient(180deg, #c5622b, var(--accent));
      color: #fff8f2;
      border-color: #8b3f16;
    }
  </style>
</head>
<body>
  <main>
    <h1>Monitor Admin</h1>
    <p class="subtle">Authenticated operator console for monitor status, event review, req investigation, and targeted task execution.</p>
    <p id="authNotice" class="notice"></p>
    <div class="stack">
      <details class="panel" open>
        <summary>Stats</summary>
        <div class="panel-body">
        <div class="toolbar">
          <button id="refreshStats" class="primary">Refresh Stats</button>
          <span id="statsWhen" class="pill"></span>
        </div>
        <div class="stats-wrap">
          <table id="statsTable" class="stats-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Day</th>
                <th>Week</th>
                <th>Month</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        </div>
      </details>
      <details class="panel" open>
        <summary>Formatted Admin Log</summary>
        <div class="panel-body">
        <div class="section-head">
          <div class="subtle">Provider-by-provider service history for the aggregated monitor and storage service layers.</div>
          <button id="openAdminLogJson">Open JSON</button>
        </div>
        <div class="history-nav">
          <button id="callHistoryNextDay">Next Day</button>
          <button id="callHistoryPrevDay">Previous Day</button>
          <span id="callHistorySummary" class="pill"></span>
        </div>
        <div id="callHistoryButtons" class="history-buttons"></div>
        <div id="adminLogTables" class="service-groups"></div>
        </div>
      </details>
      <details class="panel" open>
        <summary>Tasks</summary>
        <div class="panel-body">
        <div class="toolbar">
          <button id="refreshTasks">Refresh Tasks</button>
        </div>
        <div id="tasks"></div>
        <pre id="taskLog"></pre>
        </div>
      </details>
      <details class="panel" open>
        <summary>User UTXO Review</summary>
        <div class="panel-body">
        <div class="toolbar">
          <label>Identity Key / User ID<input id="utxoIdentityKey" class="wide-input mono" type="text" placeholder="enter identityKey or numeric userId" /></label>
          <label>Mode
            <select id="utxoMode">
              <option value="all">all invalid UTXOs</option>
              <option value="change">change only</option>
            </select>
          </label>
          <button id="runUtxoReview" class="primary">Run Review</button>
        </div>
        <div class="toolbar">
          <button id="loadUtxoUsers">Load Recently Active Users</button>
          <label>Recently Active Users
            <select id="utxoUserSelect" class="compact-select mono">
              <option value="">select a recently active user</option>
            </select>
          </label>
          <span id="utxoUserSummary" class="pill"></span>
        </div>
        <pre id="utxoReviewLog"></pre>
        </div>
      </details>
      <details class="panel" open>
        <summary>Monitor Events</summary>
        <div class="panel-body">
        <div class="toolbar">
          <label>Limit<input id="eventsLimit" type="number" value="20" min="1" max="200" /></label>
          <label>Event<input id="eventsName" type="text" placeholder="optional event name" /></label>
          <button id="refreshEvents">Load Events</button>
        </div>
        <div id="events" class="event-list"></div>
        </div>
      </details>
      <details class="panel" open>
        <summary>Req Review</summary>
        <div class="panel-body">
        <div class="toolbar">
          <label>Status<input id="reqStatus" type="text" placeholder="doubleSpend" /></label>
          <label>Txid<input id="reqTxid" type="text" placeholder="exact txid" /></label>
          <label>Min Tx Id<input id="reqMinTransactionId" type="number" value="150000" min="0" /></label>
          <label>Limit<input id="reqLimit" type="number" value="50" min="1" max="200" /></label>
          <button id="refreshReqs" class="primary">Load Review Rows</button>
        </div>
        <div class="subtle" id="reqSummary"></div>
        <div style="overflow:auto">
          <table id="reqTable">
            <thead>
              <tr>
                <th>Req</th>
                <th>Tx</th>
                <th>User</th>
                <th>Req Status</th>
                <th>Tx Status</th>
                <th>Age</th>
                <th>Txid</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody></tbody>
          </table>
        </div>
        <pre id="reqDetail"></pre>
        </div>
      </details>
    </div>
  </main>
  <script src="/admin/assets/bsv-sdk.js"></script>
  <script>
    const byId = id => document.getElementById(id)
    let authFetch
    let identityKey = ''
    let callHistoryState = { offset: 0, limit: 120, selected: null, total: 0, events: [], selectedByService: {} }
    const serviceOrder = [
      'getMerklePath',
      'getRawTx',
      'postBeef',
      'getUtxoStatus',
      'getStatusForTxids',
      'getScriptHashHistory',
      'updateFiatExchangeRates'
    ]

    async function ensureAuthFetch() {
      if (authFetch) return authFetch
      const sdk = window.bsv
      if (!sdk || !sdk.AuthFetch || !sdk.WalletClient) {
        throw new Error('BSV SDK bundle failed to load.')
      }
      const wallet = new sdk.WalletClient('auto', window.location.host)
      identityKey = (await wallet.getPublicKey({ identityKey: true })).publicKey
      authFetch = new sdk.AuthFetch(wallet)
      return authFetch
    }

    async function api(path, options) {
      const client = await ensureAuthFetch()
      const response = await client.fetch(window.location.origin + path, options)
      if (!response.ok) {
        const text = await response.text()
        throw new Error(text || response.statusText)
      }
      return response.json()
    }

    function setNotice(text) {
      byId('authNotice').textContent = text || ''
    }

    function pretty(value) {
      return JSON.stringify(value, null, 2)
    }

    function setButtonPending(id, pending, pendingText) {
      const button = byId(id)
      if (!button) return
      if (pending) {
        if (!button.dataset.originalText) button.dataset.originalText = button.textContent
        button.textContent = pendingText
        button.disabled = true
        return
      }
      button.textContent = button.dataset.originalText || button.textContent
      button.disabled = false
    }

    function statText(value) {
      if (value === null || value === undefined || value === '') return '-'
      return String(value)
    }

    function escapeHtml(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;')
    }

    function formatWhen(value) {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    }

    function toTimeValue(value) {
      if (!value) return undefined
      const date = new Date(value)
      const time = date.getTime()
      return Number.isNaN(time) ? undefined : time
    }

    function formatCallChip(call) {
      const kind = call.success ? 'ok' : 'fail'
      const status = call.success ? 'S' : 'F'
      const detail = call.result || call.error?.code || call.error?.message || ''
      const titleParts = [call.when, detail].filter(Boolean)
      return (
        '<span class="call-chip ' + kind + '" title="' + escapeHtml(titleParts.join(' | ')) + '">' +
        '<strong>' + status + '</strong>' +
        '<span>' + escapeHtml(call.msecs + 'ms') + '</span>' +
        (detail ? '<span>' + escapeHtml(detail) + '</span>' : '') +
        '</span>'
      )
    }

    function intervalCountsForService(serviceHistory) {
      const providers = Object.values(serviceHistory?.historyByProvider || {})
      return providers.reduce(
        (totals, provider) => {
          const interval = provider.resetCounts && provider.resetCounts.length ? provider.resetCounts[0] : null
          totals.success += interval?.success ?? 0
          totals.failure += interval?.failure ?? 0
          totals.error += interval?.error ?? 0
          return totals
        },
        { success: 0, failure: 0, error: 0 }
      )
    }

    function totalCountsForService(serviceHistory) {
      const providers = Object.values(serviceHistory?.historyByProvider || {})
      return providers.reduce(
        (totals, provider) => {
          totals.success += provider.totalCounts?.success ?? 0
          totals.failure += provider.totalCounts?.failure ?? 0
          totals.error += provider.totalCounts?.error ?? 0
          return totals
        },
        { success: 0, failure: 0, error: 0 }
      )
    }

    function visibleEventsForService(serviceName) {
      return (callHistoryState.events || []).filter(event => {
        const counts = intervalCountsForService(event.detailsJson?.[serviceName])
        return counts.success + counts.failure + counts.error > 0
      })
    }

    function renderServiceEventButtons(serviceName) {
      const events = visibleEventsForService(serviceName)
      if (!events.length) {
        return '<div class="service-empty">No interval activity for this service in the current day window.</div>'
      }
      const selectedId = callHistoryState.selectedByService?.[serviceName]
      return (
        '<div class="history-buttons">' +
        events
          .map(event => {
            const active = event.id === selectedId ? ' active' : ''
            return (
              '<button class="service-event-button' + active + '" data-service-name="' + escapeHtml(serviceName) + '" data-event-id="' + escapeHtml(event.id) + '">' +
              '#' + escapeHtml(event.id) + ' ' + escapeHtml(formatWhen(event.created_at)) +
              '</button>'
            )
          })
          .join('') +
        '</div>'
      )
    }

    function renderServiceGroup(serviceName) {
      const selectedId = callHistoryState.selectedByService?.[serviceName]
      const selectedEvent = (callHistoryState.events || []).find(event => event.id === selectedId) || null
      const serviceHistory = selectedEvent?.detailsJson?.[serviceName]
      const intervalTotals = intervalCountsForService(serviceHistory)
      const totalCounts = totalCountsForService(serviceHistory)
      const providers = Object.values(serviceHistory?.historyByProvider || {})

      const rows = providers.length
        ? providers
            .map(provider => {
              const interval = provider.resetCounts && provider.resetCounts.length ? provider.resetCounts[0] : null
              const since = toTimeValue(interval?.since)
              const until = toTimeValue(interval?.until)
              const recent = (provider.calls || [])
                .filter(call => {
                  const when = toTimeValue(call.when)
                  if (when === undefined) return false
                  if (since !== undefined && when < since) return false
                  if (until !== undefined && when > until) return false
                  return true
                })
                .slice(0, 5)
              return (
                '<tr>' +
                '<td>' + escapeHtml(provider.providerName) + '</td>' +
                '<td class="service-num">' + escapeHtml((interval?.success ?? 0) + '/' + (interval?.failure ?? 0) + '/' + (interval?.error ?? 0)) + '</td>' +
                '<td class="service-num">' + escapeHtml((provider.totalCounts?.success ?? 0) + '/' + (provider.totalCounts?.failure ?? 0) + '/' + (provider.totalCounts?.error ?? 0)) + '</td>' +
                '<td>' + escapeHtml(formatWhen(interval?.since)) + '</td>' +
                '<td><div class="service-list">' + (recent.length ? recent.map(formatCallChip).join('') : '<span class="service-empty">No recent calls</span>') + '</div></td>' +
                '</tr>'
              )
            })
            .join('')
        : '<tr><td colspan="5" class="service-empty">No provider data for selected event.</td></tr>'

      const selectedSummary = selectedEvent
        ? '<span class="pill">event #' + escapeHtml(selectedEvent.id) + ' interval ' + escapeHtml(intervalTotals.success + '/' + intervalTotals.failure + '/' + intervalTotals.error) + '</span>'
        : '<span class="pill">no event selected</span>'

      return (
        '<div class="service-group">' +
        '<div class="section-head"><h3>' + escapeHtml(serviceName) + '</h3>' + selectedSummary + '</div>' +
        '<div class="history-nav"><span class="pill">totals ' + escapeHtml(totalCounts.success + '/' + totalCounts.failure + '/' + totalCounts.error) + '</span></div>' +
        renderServiceEventButtons(serviceName) +
        '<table class="service-table">' +
        '<thead><tr><th>Provider</th><th class="service-num">Int S/F/E</th><th class="service-num">Tot S/F/E</th><th>Since</th><th>Recent</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
        '</table>' +
        '</div>'
      )
    }

    function renderAdminLogTables() {
      const container = byId('adminLogTables')
      container.innerHTML = serviceOrder.map(renderServiceGroup).join('')
      container.querySelectorAll('.service-event-button').forEach(button => {
        button.onclick = () => {
          const serviceName = button.getAttribute('data-service-name')
          const eventId = Number(button.getAttribute('data-event-id'))
          if (!serviceName || !eventId) return
          callHistoryState.selectedByService[serviceName] = eventId
          renderAdminLogTables()
        }
      })
    }

    function openAdminLogJsonPopup() {
      const selected = serviceOrder.reduce((acc, serviceName) => {
        const eventId = callHistoryState.selectedByService?.[serviceName]
        const event = (callHistoryState.events || []).find(item => item.id === eventId) || null
        acc[serviceName] = event
        return acc
      }, {})
      const popup = window.open('', 'monitor-admin-log-json', 'popup=yes,width=1100,height=760')
      if (!popup) {
        setNotice('Popup was blocked by the browser.')
        return
      }
      popup.document.title = 'Monitor Admin Log JSON'
      popup.document.body.innerHTML =
        '<pre style="margin:0;padding:16px;font:12px/1.4 SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;">' +
        escapeHtml(JSON.stringify(selected, null, 2)) +
        '</pre>'
    }

    async function loadCallHistory(offset = 0) {
      const query = new URLSearchParams()
      query.set('offset', String(Math.max(0, offset)))
      query.set('limit', String(callHistoryState.limit || 10))
      const result = await api('/admin/api/call-history?' + query.toString())
      const nextSelectedByService = { ...(callHistoryState.selectedByService || {}) }
      serviceOrder.forEach(serviceName => {
        const visible = (result.events || []).filter(event => {
          const counts = intervalCountsForService(event.detailsJson?.[serviceName])
          return counts.success + counts.failure + counts.error > 0
        })
        if (!visible.length) {
          delete nextSelectedByService[serviceName]
          return
        }
        const existing = nextSelectedByService[serviceName]
        if (!visible.some(event => event.id === existing)) {
          nextSelectedByService[serviceName] = visible[0].id
        }
      })
      callHistoryState = {
        ...callHistoryState,
        offset: result.offset || 0,
        limit: result.limit || 10,
        selected: result.selected || null,
        total: result.total || 0,
        events: result.events || [],
        selectedByService: nextSelectedByService,
        hasNewer: !!result.hasNewer,
        hasOlder: !!result.hasOlder
      }
      byId('callHistoryButtons').innerHTML = ''
      byId('callHistorySummary').textContent = result.events && result.events.length
        ? 'day window ' + (result.offset + 1) + '-' + (result.offset + result.events.length) + ' of ' + result.total
        : 'no MonitorCallHistory events'
      byId('callHistoryNextDay').disabled = !result.hasNewer
      byId('callHistoryPrevDay').disabled = !result.hasOlder
      renderAdminLogTables()
    }

    function renderStatsTable(stats) {
      const rows = [
        { label: 'users', values: [stats.usersDay, stats.usersWeek, stats.usersMonth, stats.usersTotal] },
        [
          'change BSV',
          stats.satoshisDefaultDayFormatted ?? stats.satoshisDefaultDay,
          stats.satoshisDefaultWeekFormatted ?? stats.satoshisDefaultWeek,
          stats.satoshisDefaultMonthFormatted ?? stats.satoshisDefaultMonth,
          stats.satoshisDefaultTotalFormatted ?? stats.satoshisDefaultTotal
        ],
        [
          'other BSV',
          stats.satoshisOtherDayFormatted ?? stats.satoshisOtherDay,
          stats.satoshisOtherWeekFormatted ?? stats.satoshisOtherWeek,
          stats.satoshisOtherMonthFormatted ?? stats.satoshisOtherMonth,
          stats.satoshisOtherTotalFormatted ?? stats.satoshisOtherTotal
        ],
        ['labels', stats.labelsDay, stats.labelsWeek, stats.labelsMonth, stats.labelsTotal],
        ['tags', stats.tagsDay, stats.tagsWeek, stats.tagsMonth, stats.tagsTotal],
        ['baskets', stats.basketsDay, stats.basketsWeek, stats.basketsMonth, stats.basketsTotal],
        ['transactions', stats.transactionsDay, stats.transactionsWeek, stats.transactionsMonth, stats.transactionsTotal],
        ['completed', stats.txCompletedDay, stats.txCompletedWeek, stats.txCompletedMonth, stats.txCompletedTotal],
        ['failed', stats.txFailedDay, stats.txFailedWeek, stats.txFailedMonth, stats.txFailedTotal],
        ['abandoned', stats.txAbandonedDay, stats.txAbandonedWeek, stats.txAbandonedMonth, stats.txAbandonedTotal],
        ['nosend', stats.txNosendDay, stats.txNosendWeek, stats.txNosendMonth, stats.txNosendTotal],
        ['unproven', stats.txUnprovenDay, stats.txUnprovenWeek, stats.txUnprovenMonth, stats.txUnprovenTotal],
        ['sending', stats.txSendingDay, stats.txSendingWeek, stats.txSendingMonth, stats.txSendingTotal],
        ['unprocessed', stats.txUnprocessedDay, stats.txUnprocessedWeek, stats.txUnprocessedMonth, stats.txUnprocessedTotal],
        ['unsigned', stats.txUnsignedDay, stats.txUnsignedWeek, stats.txUnsignedMonth, stats.txUnsignedTotal],
        ['nonfinal', stats.txNonfinalDay, stats.txNonfinalWeek, stats.txNonfinalMonth, stats.txNonfinalTotal],
        ['unfail', stats.txUnfailDay, stats.txUnfailWeek, stats.txUnfailMonth, stats.txUnfailTotal]
      ].map(row =>
        Array.isArray(row)
          ? {
              label: row[0],
              values: [row[1], row[2], row[3], row[4]],
              group: row[0] === 'transactions',
              child:
                row[0] === 'completed' ||
                row[0] === 'failed' ||
                row[0] === 'abandoned' ||
                row[0] === 'nosend' ||
                row[0] === 'unproven' ||
                row[0] === 'sending' ||
                row[0] === 'unprocessed' ||
                row[0] === 'unsigned' ||
                row[0] === 'nonfinal' ||
                row[0] === 'unfail'
            }
          : row
      )
      const headers = ['Metric', 'Day', 'Week', 'Month', 'Total']
      const colWidths = headers.map((header, index) =>
        rows.reduce((max, row) => Math.max(max, statText(index === 0 ? row.label : row.values[index - 1]).length), header.length)
      )
      const table = byId('statsTable')
      const thead = table.querySelector('thead')
      const body = table.querySelector('tbody')
      table.querySelector('colgroup')?.remove()
      const colgroup = document.createElement('colgroup')
      colWidths.forEach((width, index) => {
        const col = document.createElement('col')
        const extra = index === 0 ? 2 : 1
        col.style.width = (width + extra) + 'ch'
        colgroup.appendChild(col)
      })
      table.insertBefore(colgroup, thead)
      thead.innerHTML =
        '<tr>' +
        '<th class="stats-head-label">Metric</th>' +
        '<th class="stats-head-num">Day</th>' +
        '<th class="stats-head-num">Week</th>' +
        '<th class="stats-head-num">Month</th>' +
        '<th class="stats-head-num">Total</th>' +
        '</tr>'
      body.innerHTML = ''
      rows.forEach(row => {
        const tr = document.createElement('tr')
        const label = statText(row.label)
        const classes = []
        if (row.group) classes.push('stats-group')
        if (row.child) classes.push('stats-subrow', 'stats-child')
        tr.className = classes.join(' ')
        tr.innerHTML =
          '<td class="stats-label">' + label + '</td>' +
          '<td class="stats-num">' + statText(row.values[0]) + '</td>' +
          '<td class="stats-num">' + statText(row.values[1]) + '</td>' +
          '<td class="stats-num">' + statText(row.values[2]) + '</td>' +
          '<td class="stats-num">' + statText(row.values[3]) + '</td>'
        body.appendChild(tr)
      })
    }

    function renderUtxoUsers(users, total) {
      const select = byId('utxoUserSelect')
      select.innerHTML = '<option value="">select a recent user</option>'
      users.forEach(user => {
        const option = document.createElement('option')
        option.value = user.identityKey
        option.textContent = (user.userId ?? '?') + ' | ' + user.identityKey
        select.appendChild(option)
      })
      byId('utxoUserSummary').textContent = total ? total + ' user' + (total === 1 ? '' : 's') : 'no users loaded'
    }

    async function loadStats() {
      setButtonPending('refreshStats', true, 'Loading...')
      byId('statsTable').querySelector('tbody').innerHTML =
        '<tr><td colspan="5" class="loading-text">Loading stats...</td></tr>'
      try {
        const result = await api('/admin/api/stats')
        const stats = result.stats || {}
        renderStatsTable(stats)
        byId('statsWhen').textContent = (stats.when || '').toString()
        setNotice('Authenticated as ' + result.requestedBy)
      } finally {
        setButtonPending('refreshStats', false)
      }
    }

    async function loadTasks() {
      const result = await api('/admin/api/tasks')
      const container = byId('tasks')
      container.innerHTML = ''
      result.tasks.forEach(task => {
        const row = document.createElement('div')
        row.className = 'toolbar'
        const button = document.createElement('button')
        button.textContent = 'Run'
        button.onclick = async () => {
          const run = await api('/admin/api/tasks/' + encodeURIComponent(task.name) + '/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          })
          byId('taskLog').textContent = pretty(run)
        }
        row.innerHTML = '<div><strong>' + task.name + '</strong><div class="subtle">' + task.kind + '</div></div>'
        row.appendChild(button)
        container.appendChild(row)
      })
    }

    async function loadUtxoUsers() {
      setButtonPending('loadUtxoUsers', true, 'Loading...')
      byId('utxoUserSummary').textContent = 'Loading...'
      try {
        const result = await api('/admin/api/users?limit=50')
        renderUtxoUsers(result.users || [], result.total || 0)
      } finally {
        setButtonPending('loadUtxoUsers', false)
      }
    }

    async function runUtxoReview() {
      const identityKeyValue = byId('utxoIdentityKey').value.trim()
      const identityKey = identityKeyValue || byId('utxoUserSelect').value
      if (!identityKey) {
        throw new Error('Enter or select an identityKey first.')
      }
      byId('utxoIdentityKey').value = identityKey
      const mode = byId('utxoMode').value === 'change' ? 'change' : 'all'
      setButtonPending('runUtxoReview', true, 'Running...')
      byId('utxoReviewLog').textContent = 'Running review...'
      try {
        const result = await api('/admin/api/review-utxos', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identityKey, mode })
        })
        byId('utxoReviewLog').textContent = result.log || ''
        setNotice('Authenticated as ' + result.requestedBy)
      } finally {
        setButtonPending('runUtxoReview', false)
      }
    }

    async function loadEvents() {
      const query = new URLSearchParams()
      query.set('limit', byId('eventsLimit').value || '20')
      const name = byId('eventsName').value.trim()
      if (name) query.set('event', name)
      const result = await api('/admin/api/events?' + query.toString())
      const container = byId('events')
      container.innerHTML = ''
      result.events.forEach(event => {
        const el = document.createElement('div')
        el.className = 'event'
        const details = event.detailsPretty || event.details || ''
        el.innerHTML = '<strong>' + event.event + '</strong><div class="subtle">' + event.created_at + '</div><pre>' + details + '</pre>'
        container.appendChild(el)
      })
    }

    async function loadReqs() {
      const query = new URLSearchParams()
      const status = byId('reqStatus').value.trim()
      const txid = byId('reqTxid').value.trim()
      const minTxId = byId('reqMinTransactionId').value.trim()
      const limit = byId('reqLimit').value.trim()
      if (status) query.set('status', status)
      if (txid) query.set('txid', txid)
      if (minTxId) query.set('minTransactionId', minTxId)
      if (limit) query.set('limit', limit)
      const result = await api('/admin/api/proven-tx-reqs/review?' + query.toString())
      byId('reqSummary').textContent = result.total + ' review rows'
      const body = byId('reqTable').querySelector('tbody')
      body.innerHTML = ''
      result.rows.forEach(row => {
        const tr = document.createElement('tr')
        tr.innerHTML =
          '<td>' + row.provenTxReqId + '</td>' +
          '<td>' + (row.transactionId ?? '') + '</td>' +
          '<td>' + (row.userId ?? '') + '</td>' +
          '<td>' + row.reqStatus + '</td>' +
          '<td>' + (row.txStatus ?? '') + '</td>' +
          '<td>' + row.hoursOld + 'h</td>' +
          '<td>' + row.txid + '</td>'
        const actions = document.createElement('td')
        actions.className = 'row-actions'
        const inspect = document.createElement('button')
        inspect.textContent = 'Inspect'
        inspect.onclick = async () => {
          const detail = await api('/admin/api/proven-tx-reqs/' + row.provenTxReqId)
          byId('reqDetail').textContent = pretty(detail)
        }
        const decode = document.createElement('button')
        decode.textContent = 'Decode'
        decode.onclick = async () => {
          const detail = await api('/admin/api/proven-tx-reqs/' + row.provenTxReqId + '/decode')
          byId('reqDetail').textContent = pretty(detail)
        }
        const rebroadcast = document.createElement('button')
        rebroadcast.textContent = 'Rebroadcast'
        rebroadcast.onclick = async () => {
          const provider = prompt('Provider? Use "taal" or "woc".', 'taal')
          if (!provider) return
          const result = await api('/admin/api/proven-tx-reqs/' + row.provenTxReqId + '/rebroadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider })
          })
          byId('reqDetail').textContent = pretty(result)
        }
        actions.appendChild(inspect)
        actions.appendChild(decode)
        actions.appendChild(rebroadcast)
        tr.appendChild(actions)
        body.appendChild(tr)
      })
    }

    async function init() {
      try {
        await ensureAuthFetch()
        setNotice('Authenticated as ' + identityKey)
        await Promise.all([loadStats(), loadCallHistory(), loadTasks(), loadUtxoUsers(), loadEvents(), loadReqs()])
      } catch (error) {
        setNotice(error.message || String(error))
      }
    }

    byId('refreshStats').onclick = () => loadStats().catch(error => setNotice(error.message || String(error)))
    byId('openAdminLogJson').onclick = () => openAdminLogJsonPopup()
    byId('callHistoryNextDay').onclick = () =>
      loadCallHistory(Math.max(0, callHistoryState.offset - callHistoryState.limit)).catch(error =>
        setNotice(error.message || String(error))
      )
    byId('callHistoryPrevDay').onclick = () =>
      loadCallHistory(callHistoryState.offset + callHistoryState.limit).catch(error =>
        setNotice(error.message || String(error))
      )
    byId('refreshTasks').onclick = () => loadTasks().catch(error => setNotice(error.message || String(error)))
    byId('loadUtxoUsers').onclick = () => loadUtxoUsers().catch(error => setNotice(error.message || String(error)))
    byId('utxoUserSelect').onchange = event => {
      const value = event.target && event.target.value ? event.target.value : ''
      if (value) byId('utxoIdentityKey').value = value
    }
    byId('runUtxoReview').onclick = () => runUtxoReview().catch(error => setNotice(error.message || String(error)))
    byId('refreshEvents').onclick = () => loadEvents().catch(error => setNotice(error.message || String(error)))
    byId('refreshReqs').onclick = () => loadReqs().catch(error => setNotice(error.message || String(error)))

    init()
  </script>
</body>
</html>`
}
