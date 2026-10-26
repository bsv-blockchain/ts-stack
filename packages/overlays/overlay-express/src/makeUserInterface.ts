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
  /** Per-response CSP nonce supplied by OverlayExpress. */
  scriptNonce?: string
}

function htmlAttribute(value: string): string {
  return value
    .split('&').join('&amp;')
    .split('"').join('&quot;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
}

function javascriptString(value: string): string {
  return JSON.stringify(value)
    .split('<').join('\\u003c')
    .split('>').join('\\u003e')
    .split('&').join('\\u0026')
    .split('\u2028').join('\\u2028')
    .split('\u2029').join('\\u2029')
}

function legacyMarkdownValue(value: string): string {
  const trimmed = value.trim()
  return trimmed.startsWith('`') && trimmed.endsWith('`')
    ? trimmed.slice(1, -1).split('\\`').join('`')
    : value
}

function assertStyleSafe(name: string, value: string): void {
  if (/[<>]/.test(value)) {
    throw new TypeError(`${name} must not contain HTML delimiters`)
  }
}

export default function makeUserInterface (config: UIConfig = {}): string {
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
    adminIdentityKey = '',
    scriptNonce = ''
  } = config
  if (scriptNonce !== '' && !/^[A-Za-z0-9+/=_-]{16,256}$/.test(scriptNonce)) {
    throw new TypeError('scriptNonce is invalid')
  }
  for (const [name, value] of Object.entries({
    backgroundColor,
    primaryTextColor,
    primaryColor,
    secondaryColor,
    fontFamily,
    headingFontFamily,
    additionalStyles,
    sectionBackgroundColor,
    linkColor,
    hoverColor,
    borderColor,
    secondaryBackgroundColor,
    secondaryTextColor
  })) {
    assertStyleSafe(name, value)
  }
  const nonceAttribute = scriptNonce === '' ? '' : ` nonce="${htmlAttribute(scriptNonce)}"`
  const defaultMarkdown = legacyMarkdownValue(defaultContent)

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Overlay Services</title>
  <link rel="icon" type="image/x-icon" href="${htmlAttribute(faviconUrl)}">
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
  <script${nonceAttribute} src="https://cdn.jsdelivr.net/npm/showdown@2.0.3/dist/showdown.min.js" integrity="sha384-raA/ys24v0l7dngtwYK4UcAbwhBBfjsrebIGkf+0SeDc45oiqT1aDqb6k8jWBLb2" crossorigin="anonymous"></script>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.7.0/build/styles/atom-one-dark.min.css" integrity="sha384-oaMLBGEzBOJx3UHwac0cVndtX5fxGQIfnAeFZ35RTgqPcYlbprH9o9PUV/F8Le07" crossorigin="anonymous">
  <script${nonceAttribute} src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.7.0/build/highlight.min.js" integrity="sha384-4l+9bhb7rakZ18megzl0/DWczL8ojbDl1jIEzBVffeMho9A6xB/lkqt1K0PC8Jin" crossorigin="anonymous"></script>
  <script${nonceAttribute}>
    const faviconUrl = ${javascriptString(faviconUrl)};
    const HOST = ${javascriptString(host)};
    const CONFIGURED_ADMIN_IDENTITY_KEY = ${javascriptString(adminIdentityKey)};
    const DEFAULT_MARKDOWN = ${javascriptString(defaultMarkdown)};

    /* ==========================================
       MARKDOWN CONVERTER
    ========================================== */
    const showdown = window.showdown;
    window.hljs.configure({ languages: ['typescript', 'javascript', 'json', 'html', 'css', 'bash', 'markdown'] });

    const sanitizeRenderedHtml = (html) => {
      const allowed = new Set([
        'A', 'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DEL', 'EM', 'H1', 'H2', 'H3',
        'H4', 'H5', 'H6', 'HR', 'I', 'IMG', 'LI', 'OL', 'P', 'PRE', 'STRONG',
        'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'UL'
      ]);
      const dropWithContent = new Set([
        'BASE', 'BUTTON', 'EMBED', 'FORM', 'IFRAME', 'INPUT', 'LINK', 'META',
        'OBJECT', 'SCRIPT', 'STYLE', 'SVG', 'TEMPLATE'
      ]);
      const template = document.createElement('template');
      template.innerHTML = String(html || '');
      for (const element of Array.from(template.content.querySelectorAll('*'))) {
        if (dropWithContent.has(element.tagName)) {
          element.remove();
          continue;
        }
        if (!allowed.has(element.tagName)) {
          element.replaceWith(...Array.from(element.childNodes));
          continue;
        }
        const original = {
          href: element.getAttribute('href'),
          src: element.getAttribute('src'),
          alt: element.getAttribute('alt'),
          title: element.getAttribute('title'),
          className: element.getAttribute('class'),
          language: element.getAttribute('data-language')
        };
        for (const attribute of Array.from(element.attributes)) {
          element.removeAttribute(attribute.name);
        }
        if (element.tagName === 'A' && original.href) {
          try {
            const target = new URL(original.href, window.location.href);
            if (['http:', 'https:', 'mailto:'].includes(target.protocol)) {
              element.setAttribute('href', target.toString());
              element.setAttribute('rel', 'noopener noreferrer');
              if (target.protocol !== 'mailto:') element.setAttribute('target', '_blank');
            }
          } catch (e) {}
        }
        if (element.tagName === 'IMG' && original.src) {
          try {
            const target = new URL(original.src, window.location.href);
            if (target.protocol === 'https:') {
              element.setAttribute('src', target.toString());
              element.setAttribute('loading', 'lazy');
              element.setAttribute('referrerpolicy', 'no-referrer');
            }
          } catch (e) {}
        }
        if (original.alt) element.setAttribute('alt', original.alt.slice(0, 1024));
        if (original.title) element.setAttribute('title', original.title.slice(0, 1024));
        if (
          element.tagName === 'CODE' &&
          original.className &&
          /^(?:hljs|language-[A-Za-z0-9_-]{1,64})(?: (?:hljs|language-[A-Za-z0-9_-]{1,64}))*$/.test(original.className)
        ) {
          element.setAttribute('class', original.className);
        }
        if (
          element.tagName === 'PRE' &&
          original.language &&
          /^[A-Za-z0-9_-]{1,64}$/.test(original.language)
        ) {
          element.setAttribute('data-language', original.language);
        }
      }
      return template.innerHTML;
    };

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
      return sanitizeRenderedHtml(converter.makeHtml(String(md || '')));
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
        window.defaultHtml = Convert(DEFAULT_MARKDOWN);
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
      const selectedItem = Array.from(document.querySelectorAll('.list-item a')).find(item => {
        return type === 'manager'
          ? item.dataset.manager === id
          : item.dataset.provider === id;
      });
      if (selectedItem) selectedItem.classList.add('active');
    };

    window.managerDocumentation = async (manager) => {
      try {
        document.getElementById('documentation_container').style.display = '';
        document.getElementById('admin_content').style.display = 'none';
        let res = await fetch(\`\${HOST}/getDocumentationForTopicManager?manager=\${encodeURIComponent(manager)}\`);
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
        let res = await fetch(\`\${HOST}/getDocumentationForLookupServiceProvider?lookupService=\${encodeURIComponent(provider)}\`);
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
        // The page deliberately does not dynamically import executable wallet
        // code from a third-party CDN. Wallet-authenticated callers can still
        // use the admin API directly; this embedded UI uses its bearer token.
        return Promise.resolve();
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
            <p class="subtitle">\${escHtml(String(d.nodeName || ''))} on \${escHtml(String(d.network || ''))}net &mdash; uptime: \${escHtml(uptime)}</p>
            <div class="stats-grid">
              <div class="stat-card"><div class="stat-label">SHIP Records</div><div class="stat-value info">\${safeNonnegativeInteger(d.shipRecordCount)}</div></div>
              <div class="stat-card"><div class="stat-label">SLAP Records</div><div class="stat-value info">\${safeNonnegativeInteger(d.slapRecordCount)}</div></div>
              <div class="stat-card"><div class="stat-label">Banned Domains</div><div class="stat-value \${safeNonnegativeInteger(d.bannedDomains) > 0 ? 'warning' : 'success'}">\${safeNonnegativeInteger(d.bannedDomains)}</div></div>
              <div class="stat-card"><div class="stat-label">Banned Outpoints</div><div class="stat-value \${safeNonnegativeInteger(d.bannedOutpoints) > 0 ? 'warning' : 'success'}">\${safeNonnegativeInteger(d.bannedOutpoints)}</div></div>
              <div class="stat-card"><div class="stat-label">Topic Managers</div><div class="stat-value">\${Array.isArray(d.topicManagers) ? d.topicManagers.length : 0}</div></div>
              <div class="stat-card"><div class="stat-label">Lookup Services</div><div class="stat-value">\${Array.isArray(d.lookupServices) ? d.lookupServices.length : 0}</div></div>
            </div>
            <h3>Quick Actions</h3>
            <div class="action-bar">
              <button class="btn btn-primary" data-ui-action="run-janitor">Run Janitor</button>
              <button class="btn btn-primary" data-ui-action="sync-ads">Sync Advertisements</button>
              \${d.gaspSyncEnabled ? '<button class="btn btn-primary" data-ui-action="gasp-sync">GASP Sync</button>' : ''}
            </div>
            <h3>Hosted Topics</h3>
            <p style="color:#999">\${(Array.isArray(d.topicManagers) ? d.topicManagers : []).map(value => escHtml(String(value))).join(', ')}</p>
            <h3>Hosted Lookup Services</h3>
            <p style="color:#999">\${(Array.isArray(d.lookupServices) ? d.lookupServices : []).map(value => escHtml(String(value))).join(', ')}</p>
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
        const records = Array.isArray(result.data.records) ? result.data.records : [];
        const total = safeNonnegativeInteger(result.data.total);
        const pg = safePositiveInteger(result.data.page);
        const pages = safePositiveInteger(result.data.pages);
        container.innerHTML = \`
          <div class="admin-panel">
            <h2>SHIP Records</h2>
            <p class="subtitle">Hosts advertising topic managers (\${total} total)</p>
            <div class="search-bar">
              <input type="text" id="ship_search" data-enter-action="ship-search" placeholder="Search by domain, topic, txid, or identity key..." value="\${escHtml(this.shipSearch)}" />
              <button class="btn btn-primary" data-ui-action="ship-search">Search</button>
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
                    <td><span class="health-dot \${healthDotClass(r.down)}"></span>\${safeNonnegativeInteger(r.down) > 0 ? 'Down: ' + safeNonnegativeInteger(r.down) : 'OK'}</td>
                    <td class="mono truncate" title="\${escHtml(String(r.domain || ''))}">\${escHtml(String(r.domain || ''))}</td>
                    <td>\${escHtml(String(r.topic || ''))}</td>
                    <td class="mono truncate" title="\${escHtml(String(r.identityKey || ''))}">\${escHtml(String(r.identityKey || '').substring(0,12))}...</td>
                    <td class="mono truncate" title="\${escHtml(String(r.txid || ''))}.\${safeNonnegativeInteger(r.outputIndex, -1)}">\${escHtml(String(r.txid || '').substring(0,8))}...\${safeNonnegativeInteger(r.outputIndex, -1)}</td>
                    <td>\${safeDate(r.createdAt)}</td>
                    <td>
                      <button class="btn btn-sm btn-primary" data-ui-action="record-health" data-domain="\${escHtml(String(r.domain || ''))}">Ping</button>
                      <button class="btn btn-sm btn-danger" data-ui-action="remove-token" data-txid="\${escHtml(String(r.txid || ''))}" data-output-index="\${safeNonnegativeInteger(r.outputIndex, -1)}" data-domain="\${escHtml(String(r.domain || ''))}">Remove</button>
                      <button class="btn btn-sm btn-warning" data-ui-action="ban-domain" data-domain="\${escHtml(String(r.domain || ''))}">Ban Host</button>
                    </td>
                  </tr>
                \`).join('')}
              </tbody>
            </table>
            </div>
            <div class="pagination">
              <button class="btn btn-sm btn-outline" \${pg <= 1 ? 'disabled' : ''} data-ui-action="ship-page" data-page="\${Math.max(1, pg - 1)}">Prev</button>
              <span class="page-info">Page \${pg} of \${pages}</span>
              <button class="btn btn-sm btn-outline" \${pg >= pages ? 'disabled' : ''} data-ui-action="ship-page" data-page="\${Math.min(pages, pg + 1)}">Next</button>
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
        const records = Array.isArray(result.data.records) ? result.data.records : [];
        const total = safeNonnegativeInteger(result.data.total);
        const pg = safePositiveInteger(result.data.page);
        const pages = safePositiveInteger(result.data.pages);
        container.innerHTML = \`
          <div class="admin-panel">
            <h2>SLAP Records</h2>
            <p class="subtitle">Hosts advertising lookup services (\${total} total)</p>
            <div class="search-bar">
              <input type="text" id="slap_search" data-enter-action="slap-search" placeholder="Search by domain, service, txid, or identity key..." value="\${escHtml(this.slapSearch)}" />
              <button class="btn btn-primary" data-ui-action="slap-search">Search</button>
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
                    <td><span class="health-dot \${healthDotClass(r.down)}"></span>\${safeNonnegativeInteger(r.down) > 0 ? 'Down: ' + safeNonnegativeInteger(r.down) : 'OK'}</td>
                    <td class="mono truncate" title="\${escHtml(String(r.domain || ''))}">\${escHtml(String(r.domain || ''))}</td>
                    <td>\${escHtml(String(r.service || ''))}</td>
                    <td class="mono truncate" title="\${escHtml(String(r.identityKey || ''))}">\${escHtml(String(r.identityKey || '').substring(0,12))}...</td>
                    <td class="mono truncate" title="\${escHtml(String(r.txid || ''))}.\${safeNonnegativeInteger(r.outputIndex, -1)}">\${escHtml(String(r.txid || '').substring(0,8))}...\${safeNonnegativeInteger(r.outputIndex, -1)}</td>
                    <td>\${safeDate(r.createdAt)}</td>
                    <td>
                      <button class="btn btn-sm btn-primary" data-ui-action="record-health" data-domain="\${escHtml(String(r.domain || ''))}">Ping</button>
                      <button class="btn btn-sm btn-danger" data-ui-action="remove-token" data-txid="\${escHtml(String(r.txid || ''))}" data-output-index="\${safeNonnegativeInteger(r.outputIndex, -1)}" data-domain="\${escHtml(String(r.domain || ''))}">Remove</button>
                      <button class="btn btn-sm btn-warning" data-ui-action="ban-domain" data-domain="\${escHtml(String(r.domain || ''))}">Ban Host</button>
                    </td>
                  </tr>
                \`).join('')}
              </tbody>
            </table>
            </div>
            <div class="pagination">
              <button class="btn btn-sm btn-outline" \${pg <= 1 ? 'disabled' : ''} data-ui-action="slap-page" data-page="\${Math.max(1, pg - 1)}">Prev</button>
              <span class="page-info">Page \${pg} of \${pages}</span>
              <button class="btn btn-sm btn-outline" \${pg >= pages ? 'disabled' : ''} data-ui-action="slap-page" data-page="\${Math.min(pages, pg + 1)}">Next</button>
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
              <button class="btn btn-danger" data-ui-action="add-ban">Ban</button>
            </div>
            <h3>Banned Domains (\${domainBans.length})</h3>
            \${domainBans.length === 0 ? '<p style="color:#777">No banned domains.</p>' : \`
            <table class="data-table">
              <thead><tr><th>Domain</th><th>Reason</th><th>Banned At</th><th>Actions</th></tr></thead>
              <tbody>
                \${domainBans.map(b => \`
                  <tr>
                    <td class="mono">\${escHtml(String(b.value || ''))}</td>
                    <td>\${escHtml(String(b.reason || 'N/A'))}</td>
                    <td>\${safeDate(b.bannedAt, true)}</td>
                    <td><button class="btn btn-sm btn-success" data-ui-action="unban" data-ban-type="domain" data-value="\${escHtml(String(b.value || ''))}">Unban</button></td>
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
                    <td class="mono truncate" title="\${escHtml(String(b.value || ''))}">\${escHtml(String(b.value || '').substring(0,20))}...</td>
                    <td class="mono">\${escHtml(String(b.domain || 'N/A'))}</td>
                    <td>\${escHtml(String(b.reason || 'N/A'))}</td>
                    <td>\${safeDate(b.bannedAt, true)}</td>
                    <td><button class="btn btn-sm btn-success" data-ui-action="unban" data-ban-type="outpoint" data-value="\${escHtml(String(b.value || ''))}">Unban</button></td>
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
              <input type="text" id="health_url" data-enter-action="health-check" placeholder="https://overlay-host.example.com" style="flex:1" />
              <button class="btn btn-primary" data-ui-action="health-check">Check Health</button>
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
              <div class="health-result-row"><span>URL</span><span class="mono">\${escHtml(String(d.url || ''))}</span></div>
              <div class="health-result-row"><span>Response Time</span><span>\${safeNonnegativeInteger(d.responseTimeMs)}ms</span></div>
              \${safeNonnegativeInteger(d.statusCode) > 0 ? \`<div class="health-result-row"><span>Status Code</span><span>\${safeNonnegativeInteger(d.statusCode)}</span></div>\` : ''}
              \${d.error ? \`<div class="health-result-row"><span>Error</span><span style="color:var(--danger-color)">\${escHtml(String(d.error))}</span></div>\` : ''}
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
        txid = String(txid || '');
        domain = String(domain || '');
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
        domain = String(domain || '');
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
      div.textContent = String(str);
      return div.innerHTML;
    }

    function safeNonnegativeInteger(value, fallback = 0) {
      return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
    }

    function safePositiveInteger(value) {
      return Number.isSafeInteger(value) && value > 0 ? value : 1;
    }

    function safeDate(value, includeTime = false) {
      if (!value) return 'N/A';
      const date = new Date(value);
      if (!Number.isFinite(date.getTime())) return 'N/A';
      return escHtml(includeTime ? date.toLocaleString() : date.toLocaleDateString());
    }

    function inputValue(id) {
      const input = document.getElementById(id);
      return input && typeof input.value === 'string' ? input.value : '';
    }

    function handleUiAction(action, dataset = {}) {
      switch (action) {
        case 'home': window.returnHome(); break;
        case 'overview': Admin.showOverview(); break;
        case 'ship': Admin.showShipRecords(1); break;
        case 'slap': Admin.showSlapRecords(1); break;
        case 'bans': Admin.showBanList(); break;
        case 'health': Admin.showHealthChecker(); break;
        case 'logout': Admin.logout(); break;
        case 'login': window.showAdminLogin(); break;
        case 'submit-login': handleAdminLogin(); break;
        case 'run-janitor': Admin.runJanitor(); break;
        case 'sync-ads': Admin.syncAds(); break;
        case 'gasp-sync': Admin.gaspSync(); break;
        case 'ship-search': Admin.showShipRecords(1, inputValue('ship_search')); break;
        case 'slap-search': Admin.showSlapRecords(1, inputValue('slap_search')); break;
        case 'health-check': Admin.healthCheck(inputValue('health_url')); break;
        case 'add-ban': Admin.addBan(); break;
        case 'record-health': Admin.healthCheck(String(dataset.domain || '')); break;
        case 'ban-domain': Admin.confirmBanDomain(String(dataset.domain || '')); break;
        case 'ship-page': Admin.showShipRecords(safePositiveInteger(Number(dataset.page))); break;
        case 'slap-page': Admin.showSlapRecords(safePositiveInteger(Number(dataset.page))); break;
        case 'remove-token': {
          const txid = String(dataset.txid || '');
          const outputIndex = Number(dataset.outputIndex);
          if (/^[0-9a-fA-F]{64}$/.test(txid) && Number.isSafeInteger(outputIndex) && outputIndex >= 0 && outputIndex <= 4294967295) {
            Admin.confirmRemoveToken(txid, outputIndex, String(dataset.domain || ''));
          } else {
            showToast('Invalid token outpoint', 'error');
          }
          break;
        }
        case 'unban': {
          const type = String(dataset.banType || '');
          if (type === 'domain' || type === 'outpoint') Admin.unban(type, String(dataset.value || ''));
          break;
        }
      }
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
          <p>Enter the server's admin bearer token. The embedded dashboard does not download or execute a wallet SDK.</p>
          <div class="admin-login-form">
            <input type="password" id="admin_token_input" data-enter-action="submit-login" placeholder="Admin Bearer Token" />
            <button class="btn btn-primary" data-ui-action="submit-login">Login with Token</button>
          </div>
          <p style="margin-top:1em;color:#777;font-size:0.85em">Wallet mutual authentication remains available to direct admin API clients configured with the server admin identity key.</p>
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
      if (type === 'manager' && id && Object.prototype.hasOwnProperty.call(managersData, id)) {
        window.managerDocumentation(id);
      } else if (type === 'provider' && id && Object.prototype.hasOwnProperty.call(providersData, id)) {
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

      document.addEventListener('click', event => {
        const target = event.target instanceof Element ? event.target.closest('[data-ui-action]') : null;
        if (!target) return;
        event.preventDefault();
        handleUiAction(target.dataset.uiAction, target.dataset);
      });
      document.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        const target = event.target;
        if (!(target instanceof HTMLElement) || !target.dataset.enterAction) return;
        event.preventDefault();
        handleUiAction(target.dataset.enterAction, target.dataset);
      });

      let managersLoaded = false;
      let providersLoaded = false;

      const checkAllLoaded = () => {
        if (managersLoaded && providersLoaded) { handleUrlHash(); }
      };

      fetch(HOST + '/listTopicManagers')
        .then(res => res.json())
        .then(managers => {
          if (!managers || typeof managers !== 'object' || Array.isArray(managers)) throw new TypeError('Invalid topic manager response');
          managersData = Object.assign(Object.create(null), managers);
          const managerList = document.getElementById('manager_list');
          Object.keys(managers).forEach(manager => {
            let managerData = managers[manager];
            let li = document.createElement('li');
            li.className = 'list-item';
            const link = document.createElement('a');
            link.dataset.manager = manager;
            link.textContent = String((managerData && managerData.name) || manager);
            link.onclick = () => window.managerDocumentation(manager);
            li.appendChild(link);
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
          if (!providers || typeof providers !== 'object' || Array.isArray(providers)) throw new TypeError('Invalid lookup provider response');
          providersData = Object.assign(Object.create(null), providers);
          const providerList = document.getElementById('provider_list');
          Object.keys(providers).forEach(provider => {
            let providerData = providers[provider];
            let li = document.createElement('li');
            li.className = 'list-item';
            const link = document.createElement('a');
            link.dataset.provider = provider;
            link.textContent = String((providerData && providerData.name) || provider);
            link.onclick = () => window.topicDocumentation(provider);
            li.appendChild(link);
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
            if (type === 'manager' && id && Object.prototype.hasOwnProperty.call(managersData, id)) { window.managerDocumentation(id); }
            else if (type === 'provider' && id && Object.prototype.hasOwnProperty.call(providersData, id)) { window.topicDocumentation(id); }
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
        <h1 class="welcome" data-ui-action="home">Overlay Services</h1>
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
          <li class="list-item"><a href="https://github.com/bsv-blockchain/ts-stack/tree/main/packages/overlays" target="_blank" rel="noopener noreferrer">Overlay packages on GitHub</a></li>
          <li class="list-item"><a href="https://bsv.brc.dev/transactions/0076" target="_blank" rel="noopener noreferrer">BRC-76 GASP</a></li>
          <li class="list-item"><a href="https://fast.brc.dev" target="_blank" rel="noopener noreferrer">Quick Start for App Developers</a></li>
        </ul>
      </div>
      <div id="admin_section">
        <div class="admin-divider"></div>
        <h3>Admin Dashboard</h3>
        <ul id="admin_list">
          <li class="list-item"><a data-admin="admin-overview" data-ui-action="overview">Overview</a></li>
          <li class="list-item"><a data-admin="admin-ship" data-ui-action="ship">SHIP Records</a></li>
          <li class="list-item"><a data-admin="admin-slap" data-ui-action="slap">SLAP Records</a></li>
          <li class="list-item"><a data-admin="admin-bans" data-ui-action="bans">Ban List</a></li>
          <li class="list-item"><a data-admin="admin-health" data-ui-action="health">Health Checker</a></li>
          <li class="list-item"><a data-ui-action="logout" style="color:var(--danger-color)">Logout</a></li>
        </ul>
      </div>
      <div id="admin_login_link" style="margin-top:1em">
        <ul style="list-style:none;padding:0">
          <li class="list-item"><a data-admin="admin-login" data-ui-action="login">Admin Login</a></li>
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
