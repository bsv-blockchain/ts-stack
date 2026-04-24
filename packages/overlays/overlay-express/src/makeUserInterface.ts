/* eslint-disable */
import generalGuide from './generalGuide.md.js'

export interface UIConfig {
  host?: string
  faviconUrl?: string
  backgroundColor?: string
  primaryColor?: string
  secondaryColor?: string
  fontFamily?: string
  headingFontFamily?: string
  additionalStyles?: string
  sectionBackgroundColor?: string
  primaryTextColor?: string
  linkColor?: string
  hoverColor?: string
  borderColor?: string
  secondaryBackgroundColor?: string
  secondaryTextColor?: string
  defaultContent?: string
  /** Admin identity key for wallet-based admin detection */
  adminIdentityKey?: string
}

export default (config: UIConfig = {}): string => {
  const {
    host = '',
    faviconUrl = 'https://bsvblockchain.org/favicon.ico',
    backgroundColor = '#191919',
    primaryTextColor = '#f0f0f0',
    primaryColor = '#3b6efb',
    secondaryColor = '#001242',
    fontFamily = 'Helvetica, Arial, sans-serif',
    headingFontFamily = 'Helvetica, Arial, sans-serif',
    additionalStyles = '',
    sectionBackgroundColor = '#323940',
    linkColor = '#579DFF',
    hoverColor = '#3A4147',
    borderColor = '#B6C2CF',
    secondaryBackgroundColor = '#f8f8f8',
    secondaryTextColor = '#0e0e0e',
    defaultContent = generalGuide,
    adminIdentityKey = ''
  } = config

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Overlay Services</title>
  <link rel="icon" type="image/x-icon" href="${faviconUrl}">
  <style>
    :root {
      --background-color: ${backgroundColor};
      --primary-color: ${primaryColor};
      --secondary-color: ${secondaryColor};
      --font-family: ${fontFamily};
      --heading-font-family: ${headingFontFamily};
      --section-background-color: ${sectionBackgroundColor};
      --link-color: ${linkColor};
      --hover-color: ${hoverColor};
      --border-color: ${borderColor};
      --secondary-background-color: ${secondaryBackgroundColor};
      --secondary-text-color: ${secondaryTextColor};
      --primary-text-color: ${primaryTextColor};
      --success-color: #22c55e;
      --warning-color: #f59e0b;
      --danger-color: #ef4444;
      --info-color: #3b82f6;
    }

    * { box-sizing: border-box; }

    body {
      font-family: var(--font-family);
      background-color: var(--background-color);
      margin: 0;
      padding: 0;
      color: var(--primary-text-color);
    }

    h1, h2, h3 { font-family: var(--heading-font-family); }
    p { line-height: 1.5; }

    .welcome {
      background-clip: text;
      color: transparent;
      background-image: linear-gradient(90deg, var(--primary-color), var(--secondary-color));
      cursor: pointer;
    }

    a { color: var(--link-color); text-decoration: none; }
    a:hover { color: var(--secondary-color); }

    .main {
      display: flex;
      flex-direction: row;
      height: 100vh;
      overflow: hidden;
    }

    .column_right {
      padding: 1.5em;
      overflow-y: auto;
    }

    .column_left {
      padding: 15px 15px 15px 35px;
      overflow-y: auto;
      width: 360px;
      min-width: 360px;
      background-color: var(--secondary-background-color);
      color: var(--secondary-text-color);
    }

    .column_right { width: calc(100% - 360px); }

    #documentation_container { padding: 0 8em; margin: 0; }

    .list-item { margin: 0; }
    .list-item a {
      display: block;
      width: 100%;
      padding: 0.5em 0.75em;
      background-color: transparent;
      border-radius: 5px;
      transition: background-color 0.3s;
      text-decoration: none;
      color: inherit;
      font-weight: 500;
      cursor: pointer;
    }
    .list-item a:hover, .list-item a.active {
      background: var(--primary-color) linear-gradient(90deg, var(--primary-color), var(--secondary-color));
      color: white;
      cursor: pointer;
      border-radius: 8px 0 0 8px;
    }
    ul#manager_list, ul#provider_list, ul#external_list, ul#admin_list {
      list-style-type: none;
      padding-left: 0;
      margin-top: 0.5em;
    }

    .detail-header { display: flex; align-items: center; margin-bottom: 1em; }
    .detail-icon { width: 60px; height: 60px; margin-right: 1em; }
    .detail-text { display: flex; flex-direction: column; }
    .detail-title { margin: 0; }
    .detail-description, .detail-version, .detail-info { margin: 0.2em 0; }
    .detail-info a { color: var(--link-color); }

    pre {
      position: relative;
      padding: 1em;
      border-radius: 5px;
      overflow: auto;
      background-color: #282c34;
      margin: 1em 0;
    }
    pre[data-language]:before {
      content: attr(data-language);
      position: absolute;
      top: 0;
      right: 0;
      padding: 0.25em 0.5em;
      font-size: 0.75em;
      color: #abb2bf;
      background-color: #3e4451;
      border-radius: 0 0 0 4px;
      text-transform: uppercase;
    }
    code {
      font-family: Menlo, Monaco, 'Courier New', monospace;
      font-size: 0.9em;
    }
    p code, li code {
      background-color: #3e4451;
      padding: 0.2em 0.4em;
      border-radius: 3px;
      white-space: nowrap;
    }

    /* ============ ADMIN DASHBOARD STYLES ============ */
    #admin_section { display: none; }
    #admin_section.visible { display: block; }
    .admin-divider { border-top: 1px solid #ccc; margin-top: 1em; padding-top: 0.5em; }

    .admin-login {
      padding: 2em 8em;
    }
    .admin-login h2 { margin-bottom: 0.5em; }
    .admin-login p { color: #999; margin-bottom: 1.5em; }
    .admin-login-form { display: flex; gap: 0.5em; align-items: center; flex-wrap: wrap; }
    .admin-login-form input {
      padding: 0.6em 1em;
      border: 1px solid #555;
      border-radius: 6px;
      background: #2a2a2a;
      color: var(--primary-text-color);
      font-size: 0.9em;
      width: 350px;
    }
    .admin-login-form input::placeholder { color: #777; }

    .btn {
      padding: 0.6em 1.2em;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.85em;
      font-weight: 600;
      transition: all 0.2s;
      display: inline-flex;
      align-items: center;
      gap: 0.4em;
    }
    .btn:hover { filter: brightness(1.1); }
    .btn-primary { background: var(--primary-color); color: white; }
    .btn-danger { background: var(--danger-color); color: white; }
    .btn-warning { background: var(--warning-color); color: #111; }
    .btn-success { background: var(--success-color); color: white; }
    .btn-sm { padding: 0.3em 0.7em; font-size: 0.8em; }
    .btn-outline {
      background: transparent;
      border: 1px solid var(--primary-color);
      color: var(--primary-color);
    }

    .admin-panel { padding: 0 8em 2em; }
    .admin-panel h2 { margin-bottom: 0.3em; }
    .admin-panel .subtitle { color: #999; margin-top: 0; margin-bottom: 1.5em; }

    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 1em;
      margin-bottom: 2em;
    }
    .stat-card {
      background: var(--section-background-color);
      border-radius: 10px;
      padding: 1.2em;
    }
    .stat-card .stat-label { font-size: 0.8em; color: #999; text-transform: uppercase; letter-spacing: 0.05em; }
    .stat-card .stat-value { font-size: 1.8em; font-weight: 700; margin: 0.1em 0; }
    .stat-card .stat-value.success { color: var(--success-color); }
    .stat-card .stat-value.warning { color: var(--warning-color); }
    .stat-card .stat-value.danger { color: var(--danger-color); }
    .stat-card .stat-value.info { color: var(--info-color); }

    .action-bar {
      display: flex;
      gap: 0.5em;
      flex-wrap: wrap;
      margin-bottom: 1.5em;
    }

    .search-bar {
      display: flex;
      gap: 0.5em;
      margin-bottom: 1em;
    }
    .search-bar input {
      flex: 1;
      padding: 0.6em 1em;
      border: 1px solid #555;
      border-radius: 6px;
      background: #2a2a2a;
      color: var(--primary-text-color);
      font-size: 0.9em;
    }
    .search-bar input::placeholder { color: #777; }

    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.85em;
    }
    .data-table th {
      text-align: left;
      padding: 0.7em 0.8em;
      background: var(--section-background-color);
      border-bottom: 2px solid #555;
      font-weight: 600;
      white-space: nowrap;
    }
    .data-table td {
      padding: 0.6em 0.8em;
      border-bottom: 1px solid #333;
      vertical-align: middle;
    }
    .data-table tr:hover td { background: rgba(255,255,255,0.03); }
    .data-table .mono {
      font-family: Menlo, Monaco, 'Courier New', monospace;
      font-size: 0.85em;
    }
    .data-table .truncate {
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .health-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      display: inline-block;
      margin-right: 0.4em;
    }
    .health-dot.green { background: var(--success-color); }
    .health-dot.yellow { background: var(--warning-color); }
    .health-dot.red { background: var(--danger-color); }
    .health-dot.gray { background: #666; }

    .pagination {
      display: flex;
      align-items: center;
      gap: 0.5em;
      margin-top: 1em;
      justify-content: center;
    }
    .pagination .page-info { color: #999; font-size: 0.85em; }

    .toast-container {
      position: fixed;
      top: 1em;
      right: 1em;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      gap: 0.5em;
    }
    .toast {
      padding: 0.8em 1.2em;
      border-radius: 8px;
      font-size: 0.85em;
      font-weight: 500;
      animation: slideIn 0.3s ease;
      max-width: 400px;
    }
    .toast.success { background: var(--success-color); color: white; }
    .toast.error { background: var(--danger-color); color: white; }
    .toast.info { background: var(--info-color); color: white; }
    @keyframes slideIn { from { opacity: 0; transform: translateX(50px); } to { opacity: 1; transform: translateX(0); } }

    .loading { color: #999; font-style: italic; padding: 2em; text-align: center; }
    .empty-state { color: #777; text-align: center; padding: 3em 1em; }
    .empty-state p { font-size: 1.1em; }

    .admin-form-row {
      display: flex; gap: 0.5em; align-items: center; margin-bottom: 1em; flex-wrap: wrap;
    }
    .admin-form-row select, .admin-form-row input {
      padding: 0.6em 1em;
      border: 1px solid #555;
      border-radius: 6px;
      background: #2a2a2a;
      color: var(--primary-text-color);
      font-size: 0.9em;
    }

    .health-result-card {
      background: var(--section-background-color);
      border-radius: 10px;
      padding: 1.5em;
      margin-top: 1em;
    }
    .health-result-card h3 { margin-top: 0; }
    .health-result-row {
      display: flex; justify-content: space-between; padding: 0.4em 0;
      border-bottom: 1px solid #444;
    }
    .health-result-row:last-child { border-bottom: none; }

    .confirm-overlay {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.6); z-index: 9998;
      display: flex; align-items: center; justify-content: center;
    }
    .confirm-dialog {
      background: #2a2a2a; border-radius: 12px; padding: 2em;
      max-width: 420px; width: 90%;
    }
    .confirm-dialog h3 { margin-top: 0; }
    .confirm-dialog .actions { display: flex; gap: 0.5em; justify-content: flex-end; margin-top: 1.5em; }

    .badge {
      display: inline-block;
      padding: 0.15em 0.5em;
      border-radius: 4px;
      font-size: 0.75em;
      font-weight: 600;
    }
    .badge-domain { background: #1e40af; color: white; }
    .badge-outpoint { background: #7c3aed; color: white; }

    @media screen and (max-width: 850px) {
      .main { flex-direction: column; }
      .column_left { max-height: 30vh; min-width: unset; }
      .column_left, .column_right { width: 90%; margin: 0; padding: 0 5%; }
      #documentation_container, .admin-panel, .admin-login { margin: 0; padding: 0; }
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
    }

    ${additionalStyles}
  </style>
  <script src="https://cdn.jsdelivr.net/npm/showdown@2.0.3/dist/showdown.min.js"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.7.0/build/styles/atom-one-dark.min.css">
  <script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.7.0/build/highlight.min.js"></script>
  <script>
    const faviconUrl = '${faviconUrl}';
    const HOST = '${host}';
    const CONFIGURED_ADMIN_IDENTITY_KEY = '${adminIdentityKey}';

    /* ==========================================
       MARKDOWN CONVERTER
    ========================================== */
    const showdown = window.showdown;
    window.hljs.configure({ languages: ['typescript', 'javascript', 'json', 'html', 'css', 'bash', 'markdown'] });

    const Convert = (md) => {
      let converter = new showdown.Converter({
        ghCompatibleHeaderId: true,
        simpleLineBreaks: true,
        ghMentions: true,
        tables: true,
        tasklists: true,
        strikethrough: true,
        parseImgDimensions: true,
        simplifiedAutoLink: true
      });
      converter.setFlavor('github');
      converter.setOption('ghCodeBlocks', true);
      converter.setOption('omitExtraWLInCodeBlocks', true);
      converter.setOption('literalMidWordUnderscores', true);
      converter.setOption('parseImgDimensions', true);
      const codeExtension = () => [
        {
          type: 'output',
          filter: function(text) {
            return text.replace(/<pre><code\\s*class="([^"]*)">(.*?)<\\/code><\\/pre>/gs, function(match, language, content) {
              if (language) {
                const lang = language.replace('language-', '').trim();
                return \`<pre data-language="\${lang}"><code class="language-\${lang} hljs">\${content}</code></pre>\`;
              } else {
                return \`<pre><code class="hljs">\${content}</code></pre>\`;
              }
            });
          }
        }
      ];
      converter.addExtension(codeExtension());
      return converter.makeHtml(md);
    };

    const applyHighlighting = () => {
      document.querySelectorAll('pre code').forEach(block => {
        const classList = Array.from(block.classList);
        const langClass = classList.find(cls => cls.startsWith('language-'));
        if (langClass) {
          const language = langClass.replace('language-', '');
          const preElement = block.parentElement;
          if (preElement) { preElement.setAttribute('data-language', language); }
        }
        try { window.hljs.highlightElement(block); } catch (e) {}
      });
    };

    /* ==========================================
       DOCUMENTATION NAVIGATION
    ========================================== */
    let managersData = {};
    let providersData = {};

    window.returnHome = () => {
      if (!window.defaultHtml) {
        window.defaultHtml = Convert(${defaultContent});
      }
      document.getElementById('documentation_container').innerHTML = window.defaultHtml;
      document.getElementById('documentation_container').style.display = '';
      document.getElementById('admin_content').style.display = 'none';
      window.location.hash = '';
      document.querySelectorAll('.list-item a').forEach(item => item.classList.remove('active'));
    };

    const updateSelectedItem = (type, id) => {
      window.location.hash = \`\${type}/\${id}\`;
      document.querySelectorAll('.list-item a').forEach(item => item.classList.remove('active'));
      const selector = \`[data-\${type}="\${id}"]\`;
      const selectedItem = document.querySelector(selector);
      if (selectedItem) selectedItem.classList.add('active');
    };

    window.managerDocumentation = async (manager) => {
      try {
        document.getElementById('documentation_container').style.display = '';
        document.getElementById('admin_content').style.display = 'none';
        let res = await fetch(\`\${HOST}/getDocumentationForTopicManager?manager=\${manager}\`);
        let docs = await res.text();
        document.getElementById('documentation_container').innerHTML = Convert(docs);
        applyHighlighting();
        updateSelectedItem('manager', manager);
      } catch (error) { console.error('Error fetching manager documentation:', error); }
    };

    window.topicDocumentation = async (provider) => {
      try {
        document.getElementById('documentation_container').style.display = '';
        document.getElementById('admin_content').style.display = 'none';
        let res = await fetch(\`\${HOST}/getDocumentationForLookupServiceProvider?lookupService=\${provider}\`);
        let docs = await res.text();
        document.getElementById('documentation_container').innerHTML = Convert(docs);
        applyHighlighting();
        updateSelectedItem('provider', provider);
      } catch (error) { console.error('Error fetching provider documentation:', error); }
    };

    /* ==========================================
       TOAST NOTIFICATIONS
    ========================================== */
    function showToast(message, type = 'info') {
      const container = document.getElementById('toast_container');
      const toast = document.createElement('div');
      toast.className = \`toast \${type}\`;
      toast.textContent = message;
      container.appendChild(toast);
      setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 4000);
    }

    /* ==========================================
       ADMIN DASHBOARD
    ========================================== */
    const Admin = {
      token: null,
      isAdmin: false,

      walletAuthMode: false,
      authFetch: null,

      init() {
        this.token = sessionStorage.getItem('adminToken');
        if (this.token) {
          this.isAdmin = true;
          this.showAdminSection();
        }
        this.tryWalletDetection();
      },

      async tryWalletDetection() {
        try {
          // Dynamically import WalletClient from the BSV SDK
          // This works when the user has a wallet extension installed
          const { WalletClient } = await import('https://cdn.jsdelivr.net/npm/@bsv/sdk@2/+esm');
          const wallet = new WalletClient('auto', window.location.origin);
          const { publicKey } = await wallet.getPublicKey({ identityKey: true });

          // Fetch the server's admin config to compare identity keys
          const configRes = await fetch(HOST + '/admin/config');
          const config = await configRes.json();

          if (config.adminIdentityKey && publicKey === config.adminIdentityKey) {
            // Identity matches the admin key - create AuthFetch for authenticated requests
            const { AuthFetch } = await import('https://cdn.jsdelivr.net/npm/@bsv/sdk@2/+esm');
            this.authFetch = new AuthFetch(wallet);
            this.walletAuthMode = true;
            this.isAdmin = true;
            this.showAdminSection();
            showToast('Wallet detected - admin access granted', 'success');
          }
        } catch (e) {
          // Wallet not available or identity doesn't match - fall back to token auth
        }
      },

      showAdminSection() {
        document.getElementById('admin_section').classList.add('visible');
      },

      async login(token) {
        // Verify token by making a test request
        try {
          const res = await fetch(\`\${HOST}/admin/stats\`, {
            headers: { 'Authorization': \`Bearer \${token}\` }
          });
          if (res.ok) {
            this.token = token;
            this.isAdmin = true;
            sessionStorage.setItem('adminToken', token);
            this.showAdminSection();
            showToast('Admin login successful', 'success');
            return true;
          } else {
            showToast('Invalid admin token', 'error');
            return false;
          }
        } catch (e) {
          showToast('Connection error', 'error');
          return false;
        }
      },

      logout() {
        this.token = null;
        this.isAdmin = false;
        this.walletAuthMode = false;
        this.authFetch = null;
        sessionStorage.removeItem('adminToken');
        document.getElementById('admin_section').classList.remove('visible');
        window.returnHome();
        showToast('Logged out', 'info');
      },

      async api(method, path, body) {
        if (!this.token && !this.walletAuthMode) { showToast('Not authenticated', 'error'); return null; }
        try {
          const url = \`\${HOST || window.location.origin}\${path}\`;

          // Use AuthFetch (BSV mutual auth) when wallet auth is active
          if (this.walletAuthMode && this.authFetch) {
            const opts = { method, headers: { 'Content-Type': 'application/json' } };
            if (body) opts.body = JSON.stringify(body);
            const res = await this.authFetch.fetch(url, opts);
            const data = await res.json();
            if (data.status === 'error') { showToast(data.message, 'error'); }
            return data;
          }

          // Fall back to Bearer token auth
          const opts = {
            method,
            headers: {
              'Authorization': \`Bearer \${this.token}\`,
              'Content-Type': 'application/json'
            }
          };
          if (body) opts.body = JSON.stringify(body);
          const res = await fetch(url, opts);
          const data = await res.json();
          if (data.status === 'error') { showToast(data.message, 'error'); }
          return data;
        } catch (e) { showToast('Request failed: ' + e.message, 'error'); return null; }
      },

      /* ---------- Dashboard Overview ---------- */
      async showOverview() {
        switchToAdmin('admin-overview');
        const container = document.getElementById('admin_content');
        container.innerHTML = '<div class="loading">Loading dashboard...</div>';
        const result = await this.api('GET', '/admin/stats');
        if (!result || result.status !== 'success') return;
        const d = result.data;
        const uptime = d.uptime ? formatDuration(d.uptime) : 'N/A';
        container.innerHTML = \`
          <div class="admin-panel">
            <h2>Dashboard Overview</h2>
            <p class="subtitle">\${d.nodeName} on \${d.network}net &mdash; uptime: \${uptime}</p>
            <div class="stats-grid">
              <div class="stat-card"><div class="stat-label">SHIP Records</div><div class="stat-value info">\${d.shipRecordCount}</div></div>
              <div class="stat-card"><div class="stat-label">SLAP Records</div><div class="stat-value info">\${d.slapRecordCount}</div></div>
              <div class="stat-card"><div class="stat-label">Banned Domains</div><div class="stat-value \${d.bannedDomains > 0 ? 'warning' : 'success'}">\${d.bannedDomains}</div></div>
              <div class="stat-card"><div class="stat-label">Banned Outpoints</div><div class="stat-value \${d.bannedOutpoints > 0 ? 'warning' : 'success'}">\${d.bannedOutpoints}</div></div>
              <div class="stat-card"><div class="stat-label">Topic Managers</div><div class="stat-value">\${d.topicManagers.length}</div></div>
              <div class="stat-card"><div class="stat-label">Lookup Services</div><div class="stat-value">\${d.lookupServices.length}</div></div>
            </div>
            <h3>Quick Actions</h3>
            <div class="action-bar">
              <button class="btn btn-primary" onclick="Admin.runJanitor()">Run Janitor</button>
              <button class="btn btn-primary" onclick="Admin.syncAds()">Sync Advertisements</button>
              \${d.gaspSyncEnabled ? '<button class="btn btn-primary" onclick="Admin.gaspSync()">GASP Sync</button>' : ''}
            </div>
            <h3>Hosted Topics</h3>
            <p style="color:#999">\${d.topicManagers.join(', ')}</p>
            <h3>Hosted Lookup Services</h3>
            <p style="color:#999">\${d.lookupServices.join(', ')}</p>
          </div>
        \`;
      },

      /* ---------- SHIP Records ---------- */
      shipPage: 1,
      shipSearch: '',
      async showShipRecords(page, search) {
        switchToAdmin('admin-ship');
        this.shipPage = page || 1;
        this.shipSearch = typeof search === 'string' ? search : this.shipSearch;
        const container = document.getElementById('admin_content');
        container.innerHTML = '<div class="loading">Loading SHIP records...</div>';
        const qs = \`?page=\${this.shipPage}&limit=30\${this.shipSearch ? '&search=' + encodeURIComponent(this.shipSearch) : ''}\`;
        const result = await this.api('GET', '/admin/ship-records' + qs);
        if (!result || result.status !== 'success') return;
        const { records, total, page: pg, pages } = result.data;
        container.innerHTML = \`
          <div class="admin-panel">
            <h2>SHIP Records</h2>
            <p class="subtitle">Hosts advertising topic managers (\${total} total)</p>
            <div class="search-bar">
              <input type="text" id="ship_search" placeholder="Search by domain, topic, txid, or identity key..." value="\${escHtml(this.shipSearch)}" onkeydown="if(event.key==='Enter')Admin.showShipRecords(1,this.value)" />
              <button class="btn btn-primary" onclick="Admin.showShipRecords(1,document.getElementById('ship_search').value)">Search</button>
            </div>
            \${records.length === 0 ? '<div class="empty-state"><p>No SHIP records found.</p></div>' : \`
            <div style="overflow-x:auto">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Health</th>
                  <th>Domain</th>
                  <th>Topic</th>
                  <th>Identity Key</th>
                  <th>Outpoint</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                \${records.map(r => \`
                  <tr>
                    <td><span class="health-dot \${healthDotClass(r.down)}"></span>\${r.down ? 'Down: '+r.down : 'OK'}</td>
                    <td class="mono truncate" title="\${escHtml(r.domain)}">\${escHtml(r.domain)}</td>
                    <td>\${escHtml(r.topic)}</td>
                    <td class="mono truncate" title="\${escHtml(r.identityKey)}">\${escHtml((r.identityKey||'').substring(0,12))}...</td>
                    <td class="mono truncate" title="\${r.txid}.\${r.outputIndex}">\${r.txid.substring(0,8)}...\${r.outputIndex}</td>
                    <td>\${r.createdAt ? new Date(r.createdAt).toLocaleDateString() : 'N/A'}</td>
                    <td>
                      <button class="btn btn-sm btn-primary" onclick="Admin.healthCheck('\${escHtml(r.domain)}')">Ping</button>
                      <button class="btn btn-sm btn-danger" onclick="Admin.confirmRemoveToken('\${r.txid}', \${r.outputIndex}, '\${escHtml(r.domain)}')">Remove</button>
                      <button class="btn btn-sm btn-warning" onclick="Admin.confirmBanDomain('\${escHtml(r.domain)}')">Ban Host</button>
                    </td>
                  </tr>
                \`).join('')}
              </tbody>
            </table>
            </div>
            <div class="pagination">
              <button class="btn btn-sm btn-outline" \${pg <= 1 ? 'disabled' : ''} onclick="Admin.showShipRecords(\${pg - 1})">Prev</button>
              <span class="page-info">Page \${pg} of \${pages}</span>
              <button class="btn btn-sm btn-outline" \${pg >= pages ? 'disabled' : ''} onclick="Admin.showShipRecords(\${pg + 1})">Next</button>
            </div>
            \`}
          </div>
        \`;
      },

      /* ---------- SLAP Records ---------- */
      slapPage: 1,
      slapSearch: '',
      async showSlapRecords(page, search) {
        switchToAdmin('admin-slap');
        this.slapPage = page || 1;
        this.slapSearch = typeof search === 'string' ? search : this.slapSearch;
        const container = document.getElementById('admin_content');
        container.innerHTML = '<div class="loading">Loading SLAP records...</div>';
        const qs = \`?page=\${this.slapPage}&limit=30\${this.slapSearch ? '&search=' + encodeURIComponent(this.slapSearch) : ''}\`;
        const result = await this.api('GET', '/admin/slap-records' + qs);
        if (!result || result.status !== 'success') return;
        const { records, total, page: pg, pages } = result.data;
        container.innerHTML = \`
          <div class="admin-panel">
            <h2>SLAP Records</h2>
            <p class="subtitle">Hosts advertising lookup services (\${total} total)</p>
            <div class="search-bar">
              <input type="text" id="slap_search" placeholder="Search by domain, service, txid, or identity key..." value="\${escHtml(this.slapSearch)}" onkeydown="if(event.key==='Enter')Admin.showSlapRecords(1,this.value)" />
              <button class="btn btn-primary" onclick="Admin.showSlapRecords(1,document.getElementById('slap_search').value)">Search</button>
            </div>
            \${records.length === 0 ? '<div class="empty-state"><p>No SLAP records found.</p></div>' : \`
            <div style="overflow-x:auto">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Health</th>
                  <th>Domain</th>
                  <th>Service</th>
                  <th>Identity Key</th>
                  <th>Outpoint</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                \${records.map(r => \`
                  <tr>
                    <td><span class="health-dot \${healthDotClass(r.down)}"></span>\${r.down ? 'Down: '+r.down : 'OK'}</td>
                    <td class="mono truncate" title="\${escHtml(r.domain)}">\${escHtml(r.domain)}</td>
                    <td>\${escHtml(r.service)}</td>
                    <td class="mono truncate" title="\${escHtml(r.identityKey)}">\${escHtml((r.identityKey||'').substring(0,12))}...</td>
                    <td class="mono truncate" title="\${r.txid}.\${r.outputIndex}">\${r.txid.substring(0,8)}...\${r.outputIndex}</td>
                    <td>\${r.createdAt ? new Date(r.createdAt).toLocaleDateString() : 'N/A'}</td>
                    <td>
                      <button class="btn btn-sm btn-primary" onclick="Admin.healthCheck('\${escHtml(r.domain)}')">Ping</button>
                      <button class="btn btn-sm btn-danger" onclick="Admin.confirmRemoveToken('\${r.txid}', \${r.outputIndex}, '\${escHtml(r.domain)}')">Remove</button>
                      <button class="btn btn-sm btn-warning" onclick="Admin.confirmBanDomain('\${escHtml(r.domain)}')">Ban Host</button>
                    </td>
                  </tr>
                \`).join('')}
              </tbody>
            </table>
            </div>
            <div class="pagination">
              <button class="btn btn-sm btn-outline" \${pg <= 1 ? 'disabled' : ''} onclick="Admin.showSlapRecords(\${pg - 1})">Prev</button>
              <span class="page-info">Page \${pg} of \${pages}</span>
              <button class="btn btn-sm btn-outline" \${pg >= pages ? 'disabled' : ''} onclick="Admin.showSlapRecords(\${pg + 1})">Next</button>
            </div>
            \`}
          </div>
        \`;
      },

      /* ---------- Ban List ---------- */
      async showBanList() {
        switchToAdmin('admin-bans');
        const container = document.getElementById('admin_content');
        container.innerHTML = '<div class="loading">Loading ban list...</div>';
        const result = await this.api('GET', '/admin/bans');
        if (!result || result.status !== 'success') return;
        const bans = result.data.bans || [];
        const domainBans = bans.filter(b => b.type === 'domain');
        const outpointBans = bans.filter(b => b.type === 'outpoint');
        container.innerHTML = \`
          <div class="admin-panel">
            <h2>Ban List</h2>
            <p class="subtitle">Banned domains and outpoints are blocked from being re-synced via GASP (\${bans.length} total)</p>
            <h3>Add Ban</h3>
            <div class="admin-form-row">
              <select id="ban_type"><option value="domain">Domain</option><option value="outpoint">Outpoint</option></select>
              <input type="text" id="ban_value" placeholder="e.g. https://dead-host.example.com or txid.outputIndex" style="flex:1" />
              <input type="text" id="ban_reason" placeholder="Reason (optional)" style="width:200px" />
              <button class="btn btn-danger" onclick="Admin.addBan()">Ban</button>
            </div>
            <h3>Banned Domains (\${domainBans.length})</h3>
            \${domainBans.length === 0 ? '<p style="color:#777">No banned domains.</p>' : \`
            <table class="data-table">
              <thead><tr><th>Domain</th><th>Reason</th><th>Banned At</th><th>Actions</th></tr></thead>
              <tbody>
                \${domainBans.map(b => \`
                  <tr>
                    <td class="mono">\${escHtml(b.value)}</td>
                    <td>\${escHtml(b.reason || 'N/A')}</td>
                    <td>\${new Date(b.bannedAt).toLocaleString()}</td>
                    <td><button class="btn btn-sm btn-success" onclick="Admin.unban('domain','\${escHtml(b.value)}')">Unban</button></td>
                  </tr>
                \`).join('')}
              </tbody>
            </table>\`}
            <h3 style="margin-top:2em">Banned Outpoints (\${outpointBans.length})</h3>
            \${outpointBans.length === 0 ? '<p style="color:#777">No banned outpoints.</p>' : \`
            <table class="data-table">
              <thead><tr><th>Outpoint</th><th>Domain</th><th>Reason</th><th>Banned At</th><th>Actions</th></tr></thead>
              <tbody>
                \${outpointBans.map(b => \`
                  <tr>
                    <td class="mono truncate" title="\${escHtml(b.value)}">\${escHtml(b.value.substring(0,20))}...</td>
                    <td class="mono">\${escHtml(b.domain || 'N/A')}</td>
                    <td>\${escHtml(b.reason || 'N/A')}</td>
                    <td>\${new Date(b.bannedAt).toLocaleString()}</td>
                    <td><button class="btn btn-sm btn-success" onclick="Admin.unban('outpoint','\${escHtml(b.value)}')">Unban</button></td>
                  </tr>
                \`).join('')}
              </tbody>
            </table>\`}
          </div>
        \`;
      },

      /* ---------- Health Checker ---------- */
      async showHealthChecker() {
        switchToAdmin('admin-health');
        const container = document.getElementById('admin_content');
        container.innerHTML = \`
          <div class="admin-panel">
            <h2>Health Checker</h2>
            <p class="subtitle">Ping a host's /health endpoint to verify it is online</p>
            <div class="admin-form-row">
              <input type="text" id="health_url" placeholder="https://overlay-host.example.com" style="flex:1" onkeydown="if(event.key==='Enter')Admin.healthCheck(this.value)" />
              <button class="btn btn-primary" onclick="Admin.healthCheck(document.getElementById('health_url').value)">Check Health</button>
            </div>
            <div id="health_results"></div>
          </div>
        \`;
      },

      async healthCheck(url) {
        if (!url) return;
        showToast('Checking health of ' + url + '...', 'info');
        const result = await this.api('POST', '/admin/health-check', { url });
        if (!result || result.status !== 'success') return;
        const d = result.data;
        const resultsEl = document.getElementById('health_results');
        if (resultsEl) {
          resultsEl.innerHTML = \`
            <div class="health-result-card">
              <h3><span class="health-dot \${d.healthy ? 'green' : 'red'}"></span>\${d.healthy ? 'Healthy' : 'Unhealthy'}</h3>
              <div class="health-result-row"><span>URL</span><span class="mono">\${escHtml(d.url)}</span></div>
              <div class="health-result-row"><span>Response Time</span><span>\${d.responseTimeMs}ms</span></div>
              \${d.statusCode ? \`<div class="health-result-row"><span>Status Code</span><span>\${d.statusCode}</span></div>\` : ''}
              \${d.error ? \`<div class="health-result-row"><span>Error</span><span style="color:var(--danger-color)">\${escHtml(d.error)}</span></div>\` : ''}
            </div>
          \`;
        } else {
          showToast(url + ' is ' + (d.healthy ? 'HEALTHY' : 'UNHEALTHY') + ' (' + d.responseTimeMs + 'ms)', d.healthy ? 'success' : 'error');
        }
      },

      /* ---------- Actions ---------- */
      async runJanitor() {
        showToast('Running janitor...', 'info');
        const result = await this.api('POST', '/admin/janitor');
        if (!result || result.status !== 'success') return;
        const s = result.data?.summary;
        if (s) {
          showToast(\`Janitor complete: \${s.totalChecked} checked, \${s.healthy} healthy, \${s.unhealthy} unhealthy, \${s.removed} removed, \${s.banned} banned\`, 'success');
        } else {
          showToast('Janitor run completed', 'success');
        }
      },

      async syncAds() {
        showToast('Syncing advertisements...', 'info');
        const result = await this.api('POST', '/admin/syncAdvertisements');
        if (result && result.status === 'success') showToast('Advertisements synced', 'success');
      },

      async gaspSync() {
        showToast('Starting GASP sync (this may take a while)...', 'info');
        const result = await this.api('POST', '/admin/startGASPSync');
        if (result && result.status === 'success') showToast('GASP sync completed', 'success');
      },

      async addBan() {
        const type = document.getElementById('ban_type').value;
        const value = document.getElementById('ban_value').value.trim();
        const reason = document.getElementById('ban_reason').value.trim();
        if (!value) { showToast('Value is required', 'error'); return; }
        const result = await this.api('POST', '/admin/ban', { type, value, reason: reason || undefined });
        if (result && result.status === 'success') {
          showToast(result.message, 'success');
          this.showBanList();
        }
      },

      async unban(type, value) {
        const result = await this.api('POST', '/admin/unban', { type, value });
        if (result && result.status === 'success') {
          showToast(result.message, 'success');
          this.showBanList();
        }
      },

      confirmRemoveToken(txid, outputIndex, domain) {
        showConfirm(
          'Remove Token',
          \`Remove token <code>\${txid.substring(0,12)}...\${outputIndex}</code> from \${escHtml(domain)}?\`,
          [
            { label: 'Remove Only', class: 'btn-danger', action: () => this.removeToken(txid, outputIndex, false, false) },
            { label: 'Remove & Ban Outpoint', class: 'btn-warning', action: () => this.removeToken(txid, outputIndex, true, false) },
            { label: 'Remove & Ban Domain', class: 'btn-warning', action: () => this.removeToken(txid, outputIndex, true, true) },
          ]
        );
      },

      confirmBanDomain(domain) {
        showConfirm(
          'Ban Domain',
          \`Ban <strong>\${escHtml(domain)}</strong>?<br><br>This will remove ALL SHIP and SLAP records for this domain and prevent GASP from re-syncing them.\`,
          [
            { label: 'Ban Domain', class: 'btn-danger', action: () => this.banDomain(domain) },
          ]
        );
      },

      async removeToken(txid, outputIndex, ban, banDomain) {
        const result = await this.api('POST', '/admin/remove-token', { txid, outputIndex, ban, banDomain });
        if (result && result.status === 'success') {
          showToast(result.message, 'success');
          // Refresh current view
          const hash = window.location.hash.substring(1);
          if (hash.startsWith('admin/ship')) this.showShipRecords(this.shipPage);
          else if (hash.startsWith('admin/slap')) this.showSlapRecords(this.slapPage);
        }
      },

      async banDomain(domain) {
        const result = await this.api('POST', '/admin/ban', { type: 'domain', value: domain, reason: 'Manually banned by admin' });
        if (result && result.status === 'success') {
          showToast(result.message, 'success');
          const hash = window.location.hash.substring(1);
          if (hash.startsWith('admin/ship')) this.showShipRecords(this.shipPage);
          else if (hash.startsWith('admin/slap')) this.showSlapRecords(this.slapPage);
          else if (hash.startsWith('admin/ban')) this.showBanList();
        }
      }
    };

    /* ==========================================
       HELPERS
    ========================================== */
    function escHtml(str) {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    function healthDotClass(downCount) {
      if (!downCount || downCount === 0) return 'green';
      if (downCount === 1) return 'yellow';
      return 'red';
    }

    function formatDuration(ms) {
      const s = Math.floor(ms / 1000);
      const d = Math.floor(s / 86400);
      const h = Math.floor((s % 86400) / 3600);
      const m = Math.floor((s % 3600) / 60);
      const parts = [];
      if (d > 0) parts.push(d + 'd');
      if (h > 0) parts.push(h + 'h');
      parts.push(m + 'm');
      return parts.join(' ');
    }

    function switchToAdmin(activeId) {
      document.getElementById('documentation_container').style.display = 'none';
      document.getElementById('admin_content').style.display = '';
      document.querySelectorAll('.list-item a').forEach(item => item.classList.remove('active'));
      const el = document.querySelector('[data-admin="' + activeId + '"]');
      if (el) el.classList.add('active');
    }

    function showConfirm(title, message, buttons) {
      const overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';
      overlay.innerHTML = \`
        <div class="confirm-dialog">
          <h3>\${title}</h3>
          <p>\${message}</p>
          <div class="actions">
            <button class="btn btn-outline" id="confirm_cancel">Cancel</button>
            \${buttons.map((b, i) => \`<button class="btn \${b.class}" id="confirm_btn_\${i}">\${b.label}</button>\`).join('')}
          </div>
        </div>
      \`;
      document.body.appendChild(overlay);
      document.getElementById('confirm_cancel').onclick = () => overlay.remove();
      buttons.forEach((b, i) => {
        document.getElementById('confirm_btn_' + i).onclick = () => { overlay.remove(); b.action(); };
      });
    }

    /* ==========================================
       ADMIN LOGIN FROM DOCS VIEW
    ========================================== */
    window.showAdminLogin = () => {
      document.getElementById('documentation_container').style.display = 'none';
      document.getElementById('admin_content').style.display = '';
      document.querySelectorAll('.list-item a').forEach(item => item.classList.remove('active'));
      const loginEl = document.querySelector('[data-admin="admin-login"]');
      if (loginEl) loginEl.classList.add('active');
      document.getElementById('admin_content').innerHTML = \`
        <div class="admin-login">
          <h2>Admin Login</h2>
          <p>Authenticate with your BSV wallet (automatic if wallet extension is present and identity key matches), or enter the admin bearer token.</p>
          <div class="admin-login-form">
            <input type="password" id="admin_token_input" placeholder="Admin Bearer Token" onkeydown="if(event.key==='Enter')handleAdminLogin()" />
            <button class="btn btn-primary" onclick="handleAdminLogin()">Login with Token</button>
          </div>
          <p style="margin-top:1em;color:#777;font-size:0.85em">If you have a BSV wallet extension installed and your identity key matches the server admin key, you will be authenticated automatically via BSV mutual authentication.</p>
        </div>
      \`;
    };

    async function handleAdminLogin() {
      const token = document.getElementById('admin_token_input').value.trim();
      if (!token) return;
      const success = await Admin.login(token);
      if (success) Admin.showOverview();
    }

    /* ==========================================
       PAGE INITIALIZATION
    ========================================== */
    const handleUrlHash = () => {
      const hash = window.location.hash.substring(1);
      if (!hash) return;
      const [type, id] = hash.split('/');
      if (type === 'manager' && id && managersData[id]) {
        window.managerDocumentation(id);
      } else if (type === 'provider' && id && providersData[id]) {
        window.topicDocumentation(id);
      } else if (type === 'admin') {
        if (!Admin.isAdmin) { window.showAdminLogin(); return; }
        switch (id) {
          case 'overview': Admin.showOverview(); break;
          case 'ship': Admin.showShipRecords(1); break;
          case 'slap': Admin.showSlapRecords(1); break;
          case 'bans': Admin.showBanList(); break;
          case 'health': Admin.showHealthChecker(); break;
          default: Admin.showOverview(); break;
        }
      }
    };

    document.addEventListener('DOMContentLoaded', () => {
      Admin.init();

      let managersLoaded = false;
      let providersLoaded = false;

      const checkAllLoaded = () => {
        if (managersLoaded && providersLoaded) { handleUrlHash(); }
      };

      fetch(HOST + '/listTopicManagers')
        .then(res => res.json())
        .then(managers => {
          managersData = managers;
          const managerList = document.getElementById('manager_list');
          Object.keys(managers).forEach(manager => {
            let managerData = managers[manager];
            let li = document.createElement('li');
            li.className = 'list-item';
            li.innerHTML = \`<a data-manager="\${manager}" onclick="window.managerDocumentation('\${manager}')">\${managerData.name}</a>\`;
            managerList.appendChild(li);
          });
          managersLoaded = true;
          checkAllLoaded();
        })
        .catch(() => {
          document.getElementById('manager_list').innerHTML = '<li style="color:#999">Failed to load</li>';
          managersLoaded = true;
          checkAllLoaded();
        });

      fetch(HOST + '/listLookupServiceProviders')
        .then(res => res.json())
        .then(providers => {
          providersData = providers;
          const providerList = document.getElementById('provider_list');
          Object.keys(providers).forEach(provider => {
            let providerData = providers[provider];
            let li = document.createElement('li');
            li.className = 'list-item';
            li.innerHTML = \`<a data-provider="\${provider}" onclick="window.topicDocumentation('\${provider}')">\${providerData.name}</a>\`;
            providerList.appendChild(li);
          });
          providersLoaded = true;
          checkAllLoaded();
        })
        .catch(() => {
          document.getElementById('provider_list').innerHTML = '<li style="color:#999">Failed to load</li>';
          providersLoaded = true;
          checkAllLoaded();
        });

      // Check hash on initial load and listen for changes
      const checkUrlHash = () => {
        const hash = window.location.hash.substring(1);
        if (hash) {
          const parts = hash.split('/');
          if (parts.length === 2) {
            const [type, id] = parts;
            if (type === 'manager' && id && managersData[id]) { window.managerDocumentation(id); }
            else if (type === 'provider' && id && providersData[id]) { window.topicDocumentation(id); }
            else if (type === 'admin') { handleUrlHash(); }
          }
        } else {
          returnHome();
        }
      };
      window.addEventListener('hashchange', checkUrlHash);
      checkUrlHash();
    });
  </script>
</head>

<body>
  <div id="toast_container" class="toast-container"></div>
  <div class="main">
    <div class="column_left">
      <div class="page_head">
        <h1 class="welcome" onclick="window.returnHome()">Overlay Services</h1>
      </div>
      <div class="topic_container">
        <h3>Topic Managers</h3>
        <ul id="manager_list"></ul>
      </div>
      <div class="provider_container">
        <h3>Lookup Services</h3>
        <ul id="provider_list"></ul>
      </div>
      <div>
        <h3>External Links</h3>
        <ul id="external_list">
          <li class="list-item"><a href="https://github.com/bsv-blockchain/overlay-services" target="_blank">Overlay Services GitHub</a></li>
          <li class="list-item"><a href="https://bsv.brc.dev/transactions/0076" target="_blank">BRC-76 GASP</a></li>
          <li class="list-item"><a href="https://fast.brc.dev" target="_blank">Quick Start for App Developers</a></li>
        </ul>
      </div>
      <div id="admin_section">
        <div class="admin-divider"></div>
        <h3>Admin Dashboard</h3>
        <ul id="admin_list">
          <li class="list-item"><a data-admin="admin-overview" onclick="Admin.showOverview()">Overview</a></li>
          <li class="list-item"><a data-admin="admin-ship" onclick="Admin.showShipRecords(1)">SHIP Records</a></li>
          <li class="list-item"><a data-admin="admin-slap" onclick="Admin.showSlapRecords(1)">SLAP Records</a></li>
          <li class="list-item"><a data-admin="admin-bans" onclick="Admin.showBanList()">Ban List</a></li>
          <li class="list-item"><a data-admin="admin-health" onclick="Admin.showHealthChecker()">Health Checker</a></li>
          <li class="list-item"><a onclick="Admin.logout()" style="color:var(--danger-color)">Logout</a></li>
        </ul>
      </div>
      <div id="admin_login_link" style="margin-top:1em">
        <ul style="list-style:none;padding:0">
          <li class="list-item"><a data-admin="admin-login" onclick="window.showAdminLogin()">Admin Login</a></li>
        </ul>
      </div>
    </div>
    <div class="column_right">
      <div id="documentation_container"></div>
      <div id="admin_content" style="display:none"></div>
    </div>
  </div>
</body>
</html>`
}
