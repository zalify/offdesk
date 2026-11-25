/* Offdesk public share viewer.
 *
 * Runs in an opaque origin (CSP sandbox): never touch cookies / localStorage /
 * sessionStorage. All dynamic content is built with DOM APIs; the only HTML
 * that reaches the page is DOMPurify output. */
(function () {
  'use strict';

  var POLL_MS = 15000;
  var PAGE_SIZE = 100;
  var BOARD_MAX = 500;
  var ROW_H = 38;
  var HEAD_H = 40;
  var OVERSCAN = 6;

  var tokenMatch = /^\/s\/([^/]+)/.exec(location.pathname);
  var TOKEN = tokenMatch ? tokenMatch[1] : '';
  var BASE = '/s/' + TOKEN;
  var ASSET_PREFIX = BASE + '/assets/';
  var appEl = document.getElementById('app');

  // ---------------------------------------------------------------- helpers

  function h(tag, props, kids) {
    var e = document.createElement(tag);
    if (props) {
      for (var k in props) {
        if (!Object.prototype.hasOwnProperty.call(props, k)) continue;
        var v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (kids) {
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        if (c === null || c === undefined || c === false) continue;
        e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return e;
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
  }

  function isDark() {
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function fmtTime(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '';
    try { return new Date(ms).toLocaleString(); } catch (e) { return ''; }
  }

  function fmtDate(v) {
    var s = String(v);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    var d = new Date(s);
    if (isNaN(d.getTime())) return s;
    try { return d.toLocaleString(); } catch (e) { return s; }
  }

  function safeHttpUrl(u) {
    return typeof u === 'string' && /^https?:\/\//i.test(u.trim()) ? u.trim() : null;
  }

  function isAssetUrl(u) {
    if (typeof u !== 'string' || u.indexOf(ASSET_PREFIX) !== 0) return false;
    return /^\d+$/.test(u.slice(ASSET_PREFIX.length));
  }

  // ----------------------------------------------------------------- network

  function NotFound() { this.notFound = true; }
  function NetworkError() { this.network = true; }

  function request(path, opts) {
    return fetch(BASE + path, opts).then(
      function (res) {
        if (res.status === 404) throw new NotFound();
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      },
      function () { throw new NetworkError(); }
    );
  }

  function getJSON(path) { return request(path, { method: 'GET', cache: 'no-store' }); }

  function postJSON(path, body) {
    return request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store'
    });
  }

  // ---------------------------------------------------------- status screens

  var stopPolling = function () {};
  var overlayClosers = [];

  function showStatus(title, text, retry) {
    stopPolling();
    document.body.className = '';
    document.title = title;
    clear(appEl);
    var box = h('main', { class: 'status' }, [h('h1', { text: title }), h('p', { text: text })]);
    if (retry) box.appendChild(h('button', { class: 'btn', type: 'button', text: 'Try again', onclick: retry }));
    box.appendChild(h('div', { class: 'footer', style: 'justify-content:center;margin-top:36px', text: 'Shared with Offdesk' }));
    appEl.appendChild(box);
  }

  function showNotAvailable() {
    showStatus('This link is not available', 'It may have been turned off, or it has expired.');
  }

  function showFailure(err, retry) {
    if (err && err.notFound) return showNotAvailable();
    if (err && err.network) return showStatus('Could not reach the server', 'Check your connection and try again.', retry);
    showStatus('Something went wrong', 'The page could not be loaded.', retry);
  }

  // --------------------------------------------------------------- polling

  function startPolling(fn) {
    var last = Date.now();
    var busy = false;
    function tick() {
      if (document.visibilityState !== 'visible' || busy) return;
      busy = true;
      last = Date.now();
      Promise.resolve().then(fn).then(function () { busy = false; }, function () { busy = false; });
    }
    var timer = setInterval(tick, POLL_MS);
    function onVis() {
      if (document.visibilityState === 'visible' && Date.now() - last >= POLL_MS) tick();
    }
    document.addEventListener('visibilitychange', onVis);
    stopPolling = function () {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
      stopPolling = function () {};
    };
  }

  // ------------------------------------------------------------- lightbox

  function openLightbox(src, alt) {
    var prevFocus = document.activeElement;
    var closeBtn = h('button', { class: 'btn close', type: 'button', 'aria-label': 'Close image', text: '✕' });
    var img = h('img', { src: src, alt: alt || '' });
    var box = h('div', { class: 'lightbox', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Image preview' },
      [closeBtn, img, alt ? h('div', { class: 'cap', text: alt }) : null]);
    function close() {
      document.removeEventListener('keydown', onKey, true);
      if (box.parentNode) box.parentNode.removeChild(box);
      if (prevFocus && prevFocus.focus) prevFocus.focus();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'Tab') { e.preventDefault(); closeBtn.focus(); }
    }
    box.addEventListener('click', close);
    img.addEventListener('click', function (e) { e.stopPropagation(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(box);
    closeBtn.focus();
  }

  // ------------------------------------------------------ markdown pipeline

  var IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg)(?:[?#].*)?$/i;
  var curAssets = {};
  var marks = new WeakMap();
  var hookInstalled = false;

  function lookupAsset(ref) {
    if (!curAssets) return null;
    var v = ref.trim();
    var u = Object.prototype.hasOwnProperty.call(curAssets, v) ? curAssets[v] : null;
    if (!u) {
      // marked percent-encodes URLs (e.g. spaces); retry with the decoded form.
      try {
        var d = decodeURI(v);
        if (Object.prototype.hasOwnProperty.call(curAssets, d)) u = curAssets[d];
      } catch (e) { /* malformed escape: no match */ }
    }
    return isAssetUrl(u) ? u : null;
  }

  function installPurifyHook() {
    if (hookInstalled) return;
    hookInstalled = true;
    // Runs before DOMPurify's URI check: swap file:// references for the
    // stored asset URL (or drop them) so no file:// request is ever possible.
    DOMPurify.addHook('uponSanitizeAttribute', function (node, data) {
      var name = data.attrName;
      if (name !== 'src' && name !== 'href') return;
      var v = String(data.attrValue || '').trim();
      if (!/^file:/i.test(v)) return;
      var tag = node.nodeName.toLowerCase();
      var asset = lookupAsset(v);
      if (tag === 'img' && name === 'src') {
        if (asset) { data.attrValue = asset; } else { data.keepAttr = false; marks.set(node, 'img-missing'); }
      } else if (tag === 'a' && name === 'href') {
        if (asset) { data.attrValue = asset; marks.set(node, 'img-link'); }
        else if (IMG_EXT_RE.test(v)) { data.keepAttr = false; marks.set(node, 'img-link-missing'); }
        else { data.keepAttr = false; marks.set(node, 'file-link'); }
      }
    });
  }

  function placeholder() {
    return h('span', { class: 'img-missing', role: 'img', 'aria-label': 'image not included', text: 'image not included' });
  }

  function replaceWithChildren(el, tag) {
    var span = document.createElement(tag || 'span');
    while (el.firstChild) span.appendChild(el.firstChild);
    el.parentNode.replaceChild(span, el);
    return span;
  }

  /** Post-process sanitised DOM: links, images, tables, task-list inputs. */
  function finishFragment(frag) {
    var i, el, list;

    list = frag.querySelectorAll('a');
    for (i = 0; i < list.length; i++) {
      el = list[i];
      var mark = marks.get(el);
      var href = el.getAttribute('href');
      if (mark === 'img-link-missing') {
        var sp = replaceWithChildren(el);
        sp.parentNode.insertBefore(placeholder(), sp.nextSibling);
        continue;
      }
      if (mark === 'file-link' || href === null) { replaceWithChildren(el); continue; }
      if (mark === 'img-link' && isAssetUrl(href)) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
        var inline = h('div', { class: 'inline-img' }, [
          h('img', { src: href, alt: el.textContent || 'image' })
        ]);
        el.parentNode.insertBefore(inline, el.nextSibling);
        continue;
      }
      if (safeHttpUrl(href) || isAssetUrl(href)) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      } else if (href.charAt(0) === '#') {
        el.removeAttribute('target');
      } else {
        replaceWithChildren(el); // javascript:, data:, mailto:, relative ... shown as text
      }
    }

    list = frag.querySelectorAll('img');
    for (i = 0; i < list.length; i++) {
      el = list[i];
      var src = el.getAttribute('src');
      el.removeAttribute('srcset');
      if (!src || marks.get(el) === 'img-missing') {
        el.parentNode.replaceChild(placeholder(), el);
      } else if (safeHttpUrl(src) || isAssetUrl(src)) {
        el.setAttribute('loading', 'lazy');
        el.setAttribute('decoding', 'async');
        el.setAttribute('referrerpolicy', 'no-referrer');
      } else {
        el.parentNode.replaceChild(placeholder(), el); // data:, relative, etc.
      }
    }

    list = frag.querySelectorAll('input');
    for (i = 0; i < list.length; i++) {
      el = list[i];
      if ((el.getAttribute('type') || '').toLowerCase() === 'checkbox') {
        el.setAttribute('disabled', '');
      } else {
        el.parentNode.removeChild(el);
      }
    }

    list = frag.querySelectorAll('table');
    for (i = 0; i < list.length; i++) {
      el = list[i];
      var wrap = h('div', { class: 'table-wrap' });
      el.parentNode.insertBefore(wrap, el);
      wrap.appendChild(el);
    }
  }

  /** Markdown text -> sanitised element. `assets` maps file:// sources to URLs. */
  function renderMarkdown(text, assets) {
    installPurifyHook();
    curAssets = assets || {};
    var out = h('div', { class: 'md' });
    var html;
    try {
      html = marked.parse(String(text), { async: false, gfm: true, breaks: true });
    } catch (e) {
      out.textContent = String(text);
      return out;
    }
    var frag = DOMPurify.sanitize(html, {
      RETURN_DOM_FRAGMENT: true,
      FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'option'],
      FORBID_ATTR: ['style']
    });
    finishFragment(frag);
    curAssets = {};
    out.appendChild(frag);
    out.addEventListener('click', function (e) {
      var t = e.target;
      if (t && t.tagName === 'IMG') {
        e.preventDefault();
        openLightbox(t.currentSrc || t.src, t.alt);
      }
    });
    return out;
  }

  // ------------------------------------------------------------ artifacts

  // Mirrors packages/app/components/DraftArtifactPreview.web.tsx
  // (parseArtifactSegments), plus the shared-page-only `database` fence.
  function parseSegments(source) {
    var trimmed = source.trim();
    if (!trimmed) return [];
    if (/^<!doctype\s+html|^<html[\s>]/i.test(trimmed)) return [{ kind: 'html', code: trimmed, standalone: true }];
    if (/^<svg[\s>]/i.test(trimmed) && /<\/svg>$/.test(trimmed)) return [{ kind: 'svg', code: trimmed, standalone: true }];
    var segs = [];
    var re = /```(mermaid|svg|html|database)\s*\n([\s\S]*?)```/gi;
    var last = 0;
    var m;
    while ((m = re.exec(source)) !== null) {
      if (m.index > last) {
        var md = source.slice(last, m.index).trim();
        if (md) segs.push({ kind: 'markdown', text: md });
      }
      var kind = m[1].toLowerCase();
      var code = m[2].trim();
      if (kind === 'database') segs.push({ kind: 'database' });
      else if (code) segs.push({ kind: kind, code: code });
      last = re.lastIndex;
    }
    if (last < source.length) {
      var tail = source.slice(last).trim();
      if (tail) segs.push({ kind: 'markdown', text: tail });
    }
    return segs;
  }

  function artifactCard(label, previewLabel, sourceLabel, makePreview, code) {
    var showingSource = false;
    var body = h('div', { class: 'card-body-wrap' });
    var toggle = h('button', { class: 'btn small', type: 'button', 'aria-pressed': 'false' });
    function paint() {
      clear(body);
      toggle.textContent = showingSource ? previewLabel : sourceLabel;
      toggle.setAttribute('aria-pressed', showingSource ? 'true' : 'false');
      body.appendChild(showingSource ? h('pre', { text: code }) : makePreview());
    }
    toggle.addEventListener('click', function () { showingSource = !showingSource; paint(); });
    paint();
    return h('section', { class: 'card', 'aria-label': label }, [
      h('div', { class: 'card-head' }, [h('span', { text: label }), h('span', { class: 'grow' }), toggle]),
      body
    ]);
  }

  function frameDoc(kind, code) {
    var dark = isDark();
    var bg = dark ? '#15171a' : '#ffffff';
    var fg = dark ? '#e4e5e7' : '#1c1e22';
    if (kind === 'svg') {
      return '<!doctype html><html><head><meta charset="utf-8"><style>' +
        'html,body{margin:0;padding:12px;background:' + bg + ';color:' + fg + ';display:flex;justify-content:center;align-items:center;min-height:calc(100vh - 24px);box-sizing:border-box}' +
        'svg{max-width:100%;height:auto}</style></head><body>' + code + '</body></html>';
    }
    if (/^<!doctype\s+html|^<html[\s>]/i.test(code)) return code;
    return '<!doctype html><html><head><meta charset="utf-8"><style>' +
      'body{margin:12px;background:' + bg + ';color:' + fg + ';font-family:system-ui,-apple-system,sans-serif}</style></head><body>' + code + '</body></html>';
  }

  function sandboxCard(kind, code, standalone) {
    var label = kind.toUpperCase() + ' artifact';
    return artifactCard(label, 'Preview', 'View source', function () {
      var f = document.createElement('iframe');
      f.setAttribute('sandbox', kind === 'html' ? 'allow-scripts' : '');
      f.setAttribute('title', kind + ' artifact preview');
      f.setAttribute('referrerpolicy', 'no-referrer');
      f.setAttribute('loading', 'lazy');
      f.className = kind + (standalone ? ' standalone' : '');
      f.setAttribute('srcdoc', frameDoc(kind, code));
      return f;
    }, code);
  }

  var mermaidLoad = null;
  var mermaidQueue = Promise.resolve();
  var mermaidSeq = 0;

  function loadMermaid() {
    if (mermaidLoad) return mermaidLoad;
    mermaidLoad = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '/s/_assets/mermaid.min.js';
      s.onload = function () {
        if (!window.mermaid) return reject(new Error('Diagram library unavailable'));
        try {
          window.mermaid.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: isDark() ? 'dark' : 'default',
            fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif'
          });
        } catch (e) { return reject(e); }
        resolve(window.mermaid);
      };
      s.onerror = function () { mermaidLoad = null; reject(new Error('Diagram library failed to load')); };
      document.head.appendChild(s);
    });
    return mermaidLoad;
  }

  function mermaidCard(code) {
    var holder = h('div', { class: 'card-body diagram' }, [h('span', { class: 'muted', text: 'Rendering diagram…' })]);
    var errBox = h('div', { class: 'err', hidden: true });
    var started = false;
    var failed = false;
    function render() {
      if (started) return;
      started = true;
      var id = 'odk-mmd-' + (++mermaidSeq);
      mermaidQueue = mermaidQueue.then(function () {
        return loadMermaid().then(function (mm) { return mm.render(id, code); });
      }).then(function (res) {
        var frag = DOMPurify.sanitize(res.svg, {
          RETURN_DOM_FRAGMENT: true,
          USE_PROFILES: { svg: true, svgFilters: true, html: true },
          ADD_TAGS: ['foreignobject'],
          ADD_ATTR: ['dominant-baseline'],
          // Keep HTML labels inside <foreignObject> (still sanitised).
          HTML_INTEGRATION_POINTS: { foreignobject: true }
        });
        clear(holder);
        holder.appendChild(frag);
      }).catch(function (e) {
        failed = true;
        errBox.hidden = false;
        errBox.textContent = 'Diagram error: ' + (e && e.message ? e.message : 'could not render');
        clear(holder);
        holder.appendChild(h('pre', { text: code }));
      }).then(function () {
        // mermaid leaves a temporary container (and on errors a bomb icon) in <body>.
        var junk = document.getElementById('d' + id);
        if (junk && junk.parentNode) junk.parentNode.removeChild(junk);
      });
    }
    var card = artifactCard('mermaid', 'Diagram', 'Code', function () {
      render();
      return h('div', null, [errBox, holder]);
    }, code);
    return card;
  }

  function renderDraftContent(content, assets) {
    var root = h('div', { class: 'draft-body' });
    var segs = parseSegments(String(content || ''));
    if (!segs.length) {
      root.appendChild(h('p', { class: 'dim', text: '(empty draft)' }));
      return root;
    }
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s.kind === 'markdown') root.appendChild(renderMarkdown(s.text, assets));
      else if (s.kind === 'mermaid') root.appendChild(mermaidCard(s.code));
      else if (s.kind === 'svg' || s.kind === 'html') root.appendChild(sandboxCard(s.kind, s.code, !!s.standalone));
      else if (s.kind === 'database') root.appendChild(h('div', { class: 'note-card', text: 'embedded database (not included in this shared page)' }));
    }
    return root;
  }

  // ------------------------------------------------------------- draft page

  function footerEl(parts) {
    var f = h('footer', { class: 'footer' });
    for (var i = 0; i < parts.length; i++) f.appendChild(h('span', { text: parts[i] }));
    return f;
  }

  function startDraft(data) {
    document.body.className = 'is-draft';
    var cur = data;
    var titleEl = h('h1');
    var bodyEl = h('div');
    var footEl = h('div');
    clear(appEl);
    appEl.appendChild(h('main', { class: 'doc' }, [h('header', null, [titleEl]), bodyEl, footEl]));

    function paint() {
      var title = typeof cur.title === 'string' && cur.title ? cur.title : 'Untitled';
      titleEl.textContent = title;
      document.title = title;
      clear(bodyEl);
      bodyEl.appendChild(renderDraftContent(cur.content, cur.assets && typeof cur.assets === 'object' ? cur.assets : {}));
      clear(footEl);
      var t = fmtTime(cur.updated_at);
      footEl.appendChild(footerEl([
        cur.mode === 'live' ? 'live' : 'snapshot',
        t ? 'updated ' + t : '',
        'Shared with Offdesk'
      ].filter(Boolean)));
    }
    paint();

    if (cur.mode === 'live') {
      startPolling(function () {
        return getJSON('/data').then(function (next) {
          if (next.kind !== 'draft' || next.updated_at === cur.updated_at) return;
          var y = window.scrollY;
          cur = next;
          paint();
          window.scrollTo(0, y);
        }, function (err) { if (err && err.notFound) showNotAvailable(); });
      });
    }
  }

  // ---------------------------------------------------------- db: cells

  var COL_W = { text: 200, number: 110, select: 150, multi_select: 230, date: 140, checkbox: 90, url: 220 };

  function colWidth(col) { return COL_W[col.type] || 180; }

  function chip(label, col) {
    var color = 'gray';
    if (col && Array.isArray(col.options)) {
      for (var i = 0; i < col.options.length; i++) {
        var o = col.options[i];
        if (o && o.name === label && typeof o.color === 'string' && /^[a-z]{1,12}$/.test(o.color)) color = o.color;
      }
    }
    return h('span', { class: 'chip c-' + color, text: label });
  }

  /** Returns an array of nodes representing a cell value (empty array = no value). */
  function valueNodes(col, v) {
    if (v === null || v === undefined || v === '') return col.type === 'checkbox' ? [tick(false)] : [];
    switch (col.type) {
      case 'number':
        return [h('span', { class: 'txt', text: typeof v === 'number' ? String(v) : String(v) })];
      case 'select':
        return [chip(String(v), col)];
      case 'multi_select': {
        var arr = Array.isArray(v) ? v : [v];
        return arr.map(function (x) { return chip(String(x), col); });
      }
      case 'date':
        return [h('span', { class: 'txt', text: fmtDate(v) })];
      case 'checkbox':
        return [tick(v === true || v === 'true')];
      case 'url': {
        var u = safeHttpUrl(String(v));
        if (u) return [h('a', { class: 'txt', href: u, target: '_blank', rel: 'noopener noreferrer', text: u })];
        return [h('span', { class: 'txt', text: String(v) })];
      }
      default:
        return [h('span', { class: 'txt', text: typeof v === 'object' ? JSON.stringify(v) : String(v) })];
    }
  }

  function tick(on) {
    return h('span', { class: 'tick' + (on ? ' on' : ''), role: 'img', 'aria-label': on ? 'checked' : 'unchecked', text: on ? '✓' : '' });
  }

  function cellEl(col, v) {
    var cls = 'cell' + (col.type === 'number' ? ' num' : col.type === 'checkbox' ? ' center' : '');
    var el = h('div', { class: cls, style: 'width:' + colWidth(col) + 'px' });
    var nodes = valueNodes(col, v);
    for (var i = 0; i < nodes.length; i++) el.appendChild(nodes[i]);
    return el;
  }

  // -------------------------------------------------------- db: side panel

  var panelState = { gen: 0, close: null };

  function closePanel() { if (panelState.close) panelState.close(); }

  function openPanel(db, rowSummary) {
    closePanel();
    var gen = ++panelState.gen;
    var prevFocus = document.activeElement;
    var closeBtn = h('button', { class: 'btn small', type: 'button', 'aria-label': 'Close panel', text: '✕' });
    var titleEl = h('h2', { text: rowSummary.title || 'Untitled' });
    var body = h('div', { class: 'panel-body' }, [h('p', { class: 'dim', text: 'Loading…' })]);
    var panel = h('aside', { class: 'panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Row details' },
      [h('div', { class: 'panel-head' }, [titleEl, closeBtn]), body]);
    var backdrop = h('div', { class: 'backdrop' });

    function close() {
      document.removeEventListener('keydown', onKey, true);
      if (panel.parentNode) panel.parentNode.removeChild(panel);
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      panelState.close = null;
      if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus();
    }
    function onKey(e) {
      if (document.querySelector('.lightbox')) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    }
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', close);
    document.addEventListener('keydown', onKey, true);
    panelState.close = close;
    document.body.appendChild(backdrop);
    document.body.appendChild(panel);
    closeBtn.focus();

    function paintRow(row) {
      if (gen !== panelState.gen) return;
      titleEl.textContent = row.title || 'Untitled';
      clear(body);
      var dl = h('dl', { class: 'props' });
      var props = row.properties && typeof row.properties === 'object' ? row.properties : {};
      db.columns.forEach(function (col) {
        var nodes = valueNodes(col, props[col.id]);
        dl.appendChild(h('dt', { text: col.name }));
        var dd = h('dd');
        if (nodes.length) nodes.forEach(function (n) { dd.appendChild(n); });
        else dd.appendChild(h('span', { class: 'dim', text: '—' }));
        dl.appendChild(dd);
      });
      if (db.columns.length) body.appendChild(dl);
      if (row.content && String(row.content).trim()) {
        if (db.columns.length) body.appendChild(h('hr', { class: 'sep' }));
        body.appendChild(renderDraftContent(row.content, {}));
      } else {
        body.appendChild(h('p', { class: 'dim', text: 'No notes.' }));
      }
    }

    getJSON('/rows/' + encodeURIComponent(rowSummary.id)).then(paintRow, function (err) {
      if (gen !== panelState.gen) return;
      if (err && err.notFound) {
        clear(body);
        body.appendChild(h('p', { class: 'dim', text: 'This row is no longer available.' }));
      } else {
        clear(body);
        body.appendChild(h('p', { class: 'dim', text: 'Could not load this row.' }));
        body.appendChild(h('button', { class: 'btn', type: 'button', text: 'Try again', onclick: function () { openPanel(db, rowSummary); } }));
      }
    });
  }

  // ----------------------------------------------------------- db: page

  function startDatabase(data) {
    document.body.className = 'is-db';
    var db = {
      columns: Array.isArray(data.columns) ? data.columns : [],
      view: data.view || { type: 'table', group_by: null, sorts: [] },
      total: typeof data.row_count === 'number' ? data.row_count : 0,
      title: data.title
    };
    var colById = {};
    db.columns.forEach(function (c) { colById[c.id] = c; });

    var groupCol = db.view.type === 'board' && db.view.group_by ? colById[db.view.group_by] : null;
    var boardCapable = !!groupCol;

    var state = {
      mode: boardCapable ? 'board' : 'table',
      search: '',
      sort: null, // {column, dir} or null = view default
      gen: 0,
      refreshed: Date.now()
    };

    document.title = data.title || 'Shared database';

    // ---- chrome
    var metaEl = h('span', { class: 'db-meta' });
    var searchEl = h('input', { type: 'search', placeholder: 'Search titles…', 'aria-label': 'Search rows', autocomplete: 'off' });
    var tableBtn = h('button', { class: 'btn', type: 'button', text: 'Table' });
    var boardBtn = h('button', { class: 'btn', type: 'button', text: 'Board' });
    var tools = h('div', { class: 'db-tools' }, [
      h('div', { class: 'search' }, [searchEl]),
      boardCapable ? h('div', { class: 'seg', role: 'group', 'aria-label': 'View' }, [tableBtn, boardBtn]) : null,
      metaEl
    ]);
    var banner = h('div', { class: 'banner err', role: 'status', hidden: true });
    var main = h('div', { class: 'db-main' }, [banner]);
    var footEl = h('div', { class: 'db-foot' });
    clear(appEl);
    appEl.appendChild(h('div', { class: 'db-head' }, [h('h1', { text: data.title || 'Shared database' }), tools]));
    appEl.appendChild(main);
    appEl.appendChild(footEl);

    var content = null; // current table/board controller {el, destroy(), refresh()}

    function setBanner(msg, retry) {
      banner.hidden = !msg;
      clear(banner);
      if (msg) {
        banner.appendChild(h('span', { text: msg }));
        if (retry) banner.appendChild(h('button', { class: 'btn small', type: 'button', text: 'Retry', onclick: retry }));
      }
    }

    function handleError(err, retry) {
      if (err && err.notFound) return showNotAvailable();
      setBanner(err && err.network ? 'Could not reach the server.' : 'Could not load rows.', retry);
    }

    function updateMeta() {
      metaEl.textContent = db.total.toLocaleString() + (db.total === 1 ? ' row' : ' rows') + (state.search ? ' matching' : '');
      clear(footEl);
      footEl.appendChild(footerEl(['live', 'refreshed ' + new Date(state.refreshed).toLocaleTimeString(), 'Shared with Offdesk']));
    }

    function queryBody(offset, limit) {
      var body = { limit: limit, offset: offset };
      if (state.search) body.search = state.search;
      return body;
    }

    function sortsForTable() {
      return state.sort ? [state.sort] : null;
    }

    // ================================================== table controller
    function makeTable() {
      var widths = db.columns.map(colWidth);
      var titleW = Math.round(Math.min(260, Math.max(150, window.innerWidth * 0.5)));
      var totalW = titleW + widths.reduce(function (a, b) { return a + b; }, 0);

      var gridEl = h('div', { class: 'grid', tabindex: '-1', role: 'grid', 'aria-label': 'Rows', 'aria-rowcount': String(db.total + 1) });
      gridEl.style.setProperty('--title-w', titleW + 'px');
      var inner = h('div', { class: 'grid-inner', style: 'width:' + totalW + 'px' });
      var headRow = h('div', { class: 'row', role: 'row' });
      var head = h('div', { class: 'grid-head' }, [headRow]);
      var bodyEl = h('div', { class: 'grid-body', role: 'rowgroup' });
      var emptyEl = h('div', { class: 'empty', text: 'No rows', hidden: true });
      inner.appendChild(head);
      inner.appendChild(bodyEl);
      gridEl.appendChild(inner);

      // header cells
      function headerCell(label, colId, type, sticky) {
        var cell = h('div', {
          class: 'cell' + (type === 'number' ? ' num' : '') + (sticky ? ' sticky' : ''),
          role: 'columnheader',
          style: 'width:' + (sticky ? titleW : colWidth({ type: type })) + 'px',
          'aria-sort': 'none'
        });
        var btn = h('button', { class: 'th-btn', type: 'button', title: 'Sort by ' + label }, [
          h('span', { class: 'lbl', text: label }),
          h('span', { class: 'arrow', 'aria-hidden': 'true' })
        ]);
        btn.addEventListener('click', function () { cycleSort(colId); });
        cell.appendChild(btn);
        cell._colId = colId;
        return cell;
      }
      var headCells = [headerCell('Title', 'title', 'text', true)];
      db.columns.forEach(function (c) { headCells.push(headerCell(c.name, c.id, c.type, false)); });
      headCells.forEach(function (c) { headRow.appendChild(c); });

      function paintSortState() {
        headCells.forEach(function (c) {
          var dir = state.sort && state.sort.column === c._colId ? state.sort.dir : null;
          c.setAttribute('aria-sort', dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none');
          c.querySelector('.arrow').textContent = dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '';
        });
      }

      function cycleSort(colId) {
        if (!state.sort || state.sort.column !== colId) state.sort = { column: colId, dir: 'asc' };
        else if (state.sort.dir === 'asc') state.sort = { column: colId, dir: 'desc' };
        else state.sort = null;
        paintSortState();
        reset();
      }

      // ---- paging
      var pages = new Map(); // pageIdx -> rows[]
      var inflight = new Set();
      var rendered = new Map(); // rowIdx -> element
      var gen = 0;
      var fetchTimer = 0;
      var raf = 0;
      var destroyed = false;

      function setHeight() {
        bodyEl.style.height = db.total * ROW_H + 'px';
        gridEl.setAttribute('aria-rowcount', String(db.total + 1));
        emptyEl.hidden = db.total !== 0;
        updateMeta();
      }

      function rowAt(i) {
        var p = pages.get(Math.floor(i / PAGE_SIZE));
        return p ? p[i % PAGE_SIZE] : undefined;
      }

      function buildRow(i) {
        var row = rowAt(i);
        var el;
        if (row) {
          el = h('div', { class: 'row', role: 'row', tabindex: '0', 'aria-rowindex': String(i + 2) });
          el._row = row;
          var t = h('div', { class: 'cell sticky', role: 'gridcell', style: 'width:' + titleW + 'px' }, [
            h('span', { class: 'txt', text: row.title || 'Untitled' })
          ]);
          el.appendChild(t);
          var props = row.properties && typeof row.properties === 'object' ? row.properties : {};
          db.columns.forEach(function (c) {
            var ce = cellEl(c, props[c.id]);
            ce.setAttribute('role', 'gridcell');
            el.appendChild(ce);
          });
        } else {
          el = h('div', { class: 'row skeleton', role: 'row', 'aria-hidden': 'true' });
          el.appendChild(h('div', { class: 'cell sticky', style: 'width:' + titleW + 'px' }));
          widths.forEach(function (w) { el.appendChild(h('div', { class: 'cell', style: 'width:' + w + 'px' })); });
        }
        el.style.top = i * ROW_H + 'px';
        el.style.width = totalW + 'px';
        el._idx = i;
        return el;
      }

      function visibleRange() {
        var top = gridEl.scrollTop - HEAD_H;
        var first = Math.max(0, Math.floor(top / ROW_H));
        var last = Math.min(db.total - 1, Math.ceil((top + gridEl.clientHeight) / ROW_H));
        return [first, last];
      }

      function renderWindow() {
        raf = 0;
        if (destroyed) return;
        var r = visibleRange();
        var a = Math.max(0, r[0] - OVERSCAN);
        var b = Math.min(db.total - 1, r[1] + OVERSCAN);
        rendered.forEach(function (el, idx) {
          if (idx < a || idx > b) { bodyEl.removeChild(el); rendered.delete(idx); }
        });
        for (var i = a; i <= b; i++) {
          if (!rendered.has(i)) {
            var el = buildRow(i);
            rendered.set(i, el);
            bodyEl.appendChild(el);
          }
        }
        scheduleFetch(false);
      }

      function requestRender() { if (!raf) raf = requestAnimationFrame(renderWindow); }

      function scheduleFetch(immediate) {
        clearTimeout(fetchTimer);
        fetchTimer = setTimeout(ensureVisiblePages, immediate ? 0 : 70);
      }

      function ensureVisiblePages() {
        if (destroyed || db.total === 0 && pages.size) return;
        var r = visibleRange();
        var p0 = Math.floor(Math.max(0, r[0]) / PAGE_SIZE);
        var p1 = Math.floor(Math.max(0, r[1]) / PAGE_SIZE);
        for (var p = p0; p <= p1; p++) if (!pages.has(p) && !inflight.has(p)) fetchPage(p);
      }

      function fetchPage(p, keep) {
        var myGen = gen;
        inflight.add(p);
        return postJSON('/query', Object.assign(queryBody(p * PAGE_SIZE, PAGE_SIZE), sortsForTable() ? { sorts: sortsForTable() } : {}))
          .then(function (res) {
            if (destroyed || myGen !== gen) return;
            inflight.delete(p);
            setBanner('');
            pages.set(p, Array.isArray(res.rows) ? res.rows : []);
            if (typeof res.total === 'number' && res.total !== db.total) { db.total = res.total; setHeight(); }
            for (var i = p * PAGE_SIZE; i < (p + 1) * PAGE_SIZE; i++) {
              var el = rendered.get(i);
              if (el) { bodyEl.removeChild(el); rendered.delete(i); }
            }
            renderWindow();
          }, function (err) {
            if (destroyed || myGen !== gen) return;
            inflight.delete(p);
            handleError(err, function () { setBanner(''); scheduleFetch(true); });
          });
      }

      function reset() {
        gen++;
        pages.clear();
        inflight.clear();
        rendered.forEach(function (el) { bodyEl.removeChild(el); });
        rendered.clear();
        gridEl.scrollTop = 0;
        renderWindow();
        scheduleFetch(true);
      }

      gridEl.addEventListener('scroll', requestRender, { passive: true });
      var onResize = function () { requestRender(); };
      window.addEventListener('resize', onResize);

      function open(el) {
        var r = el && el._row;
        if (r) openPanel(db, r);
      }
      bodyEl.addEventListener('click', function (e) {
        if (e.target.closest && e.target.closest('a')) return;
        var rowEl = e.target.closest ? e.target.closest('.row') : null;
        open(rowEl);
      });
      bodyEl.addEventListener('keydown', function (e) {
        if ((e.key === 'Enter' || e.key === ' ') && e.target.classList && e.target.classList.contains('row')) {
          e.preventDefault();
          open(e.target);
        }
      });

      paintSortState();
      setHeight();
      var wrapper = h('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column;position:relative' }, [gridEl, emptyEl]);
      emptyEl.style.position = 'absolute';
      emptyEl.style.top = HEAD_H + 10 + 'px';
      emptyEl.style.left = '0';
      emptyEl.style.right = '0';

      return {
        el: wrapper,
        mount: function () { renderWindow(); scheduleFetch(true); },
        destroy: function () {
          destroyed = true;
          gen++;
          clearTimeout(fetchTimer);
          if (raf) cancelAnimationFrame(raf);
          window.removeEventListener('resize', onResize);
        },
        search: function () { reset(); },
        refresh: function (rowCount) {
          // Drop pages that are out of view, refetch the visible ones in place.
          if (typeof rowCount === 'number' && rowCount !== db.total) { db.total = rowCount; setHeight(); }
          var r = visibleRange();
          var p0 = Math.floor(Math.max(0, r[0]) / PAGE_SIZE);
          var p1 = Math.floor(Math.max(0, r[1]) / PAGE_SIZE);
          var jobs = [];
          pages.forEach(function (_v, p) { if (p < p0 || p > p1) pages.delete(p); });
          for (var p = p0; p <= p1; p++) jobs.push(fetchPage(p));
          return Promise.all(jobs);
        }
      };
    }

    // ================================================== board controller
    function makeBoard() {
      var destroyed = false;
      var gen = 0;
      var scroller = h('div', { class: 'board', role: 'list', 'aria-label': 'Board' });
      var noteEl = h('div', { class: 'banner', hidden: true });
      var wrapper = h('div', { style: 'flex:1;min-height:0;display:flex;flex-direction:column' }, [noteEl, scroller]);
      var rows = [];

      function bucketLabel(v) {
        if (groupCol.type === 'checkbox') return v === true ? 'Checked' : 'Unchecked';
        return String(v);
      }

      function paint() {
        clear(scroller);
        var buckets = [];
        var byKey = new Map();
        function bucket(key, label, noValue) {
          if (!byKey.has(key)) {
            var b = { key: key, label: label, noValue: !!noValue, rows: [] };
            byKey.set(key, b);
            buckets.push(b);
          }
          return byKey.get(key);
        }
        // Declared options first (stable order), then anything unexpected, then "no value".
        if (groupCol.type === 'checkbox') {
          bucket('b:true', 'Checked');
          bucket('b:false', 'Unchecked');
        } else if (Array.isArray(groupCol.options)) {
          groupCol.options.forEach(function (o) { if (o && typeof o.name === 'string') bucket('s:' + o.name, o.name); });
        }
        var none = { key: 'none', label: 'No value', noValue: true, rows: [] };
        rows.forEach(function (r) {
          var p = r.properties && typeof r.properties === 'object' ? r.properties[groupCol.id] : undefined;
          if (p === undefined || p === null || p === '') { none.rows.push(r); return; }
          if (groupCol.type === 'checkbox') bucket(p === true ? 'b:true' : 'b:false', bucketLabel(p === true)).rows.push(r);
          else bucket('s:' + p, bucketLabel(p)).rows.push(r);
        });
        if (none.rows.length) buckets.push(none);

        buckets.forEach(function (b) {
          var cards = h('div', { class: 'board-cards' });
          b.rows.forEach(function (r) { cards.appendChild(card(r)); });
          var head = h('h2', null, [
            groupCol.type === 'checkbox' || b.noValue ? h('span', { text: b.label }) : chip(b.label, groupCol),
            h('span', { class: 'count', text: String(b.rows.length) })
          ]);
          scroller.appendChild(h('section', { class: 'board-col', role: 'listitem', 'aria-label': b.label }, [head, cards]));
        });
        if (!rows.length) scroller.appendChild(h('div', { class: 'empty', style: 'width:100%', text: 'No rows' }));
      }

      function card(r) {
        var el = h('button', { class: 'card-item', type: 'button' }, [h('span', { class: 't', text: r.title || 'Untitled' })]);
        var props = r.properties && typeof r.properties === 'object' ? r.properties : {};
        var shown = 0;
        for (var i = 0; i < db.columns.length && shown < 3; i++) {
          var c = db.columns[i];
          if (c.id === groupCol.id) continue;
          var nodes = valueNodes(c, props[c.id]);
          if (!nodes.length || (c.type === 'checkbox' && props[c.id] !== true)) continue;
          var line = h('div', { class: 'prop' }, [h('span', { class: 'k', text: c.name })]);
          nodes.forEach(function (n) { line.appendChild(n); });
          el.appendChild(line);
          shown++;
        }
        el.addEventListener('click', function () { openPanel(db, r); });
        return el;
      }

      function load() {
        var myGen = ++gen;
        var sorts = [{ column: groupCol.id, dir: 'asc' }];
        function page(offset, limit) {
          var b = queryBody(offset, limit);
          b.sorts = sorts;
          return postJSON('/query', b);
        }
        return page(0, 200).then(function (first) {
          var total = typeof first.total === 'number' ? first.total : first.rows.length;
          var jobs = [Promise.resolve(first)];
          if (total > 200) jobs.push(page(200, 200));
          if (total > 400) jobs.push(page(400, BOARD_MAX - 400));
          return Promise.all(jobs).then(function (res) {
            if (destroyed || myGen !== gen) return;
            rows = [];
            res.forEach(function (r) { rows = rows.concat(Array.isArray(r.rows) ? r.rows : []); });
            rows = rows.slice(0, BOARD_MAX);
            db.total = total;
            setBanner('');
            noteEl.hidden = total <= BOARD_MAX;
            noteEl.textContent = 'Showing the first ' + BOARD_MAX + ' rows — switch to table for all.';
            updateMeta();
            paint();
          });
        }).catch(function (err) {
          if (destroyed || myGen !== gen) return;
          handleError(err, function () { setBanner(''); load(); });
        });
      }

      return {
        el: wrapper,
        mount: function () { load(); },
        destroy: function () { destroyed = true; gen++; },
        search: function () { load(); },
        refresh: function () { return load(); }
      };
    }

    // ---- mode switching
    function mount() {
      if (content) content.destroy();
      clear(main);
      main.appendChild(banner);
      content = state.mode === 'board' && boardCapable ? makeBoard() : makeTable();
      main.appendChild(content.el);
      tableBtn.setAttribute('aria-pressed', state.mode === 'table' ? 'true' : 'false');
      boardBtn.setAttribute('aria-pressed', state.mode === 'board' ? 'true' : 'false');
      updateMeta();
      content.mount();
    }
    tableBtn.addEventListener('click', function () { if (state.mode !== 'table') { state.mode = 'table'; mount(); } });
    boardBtn.addEventListener('click', function () { if (state.mode !== 'board') { state.mode = 'board'; mount(); } });

    var searchTimer = 0;
    searchEl.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        var v = searchEl.value.trim();
        if (v === state.search) return;
        state.search = v;
        content.search();
      }, 300);
    });

    mount();

    // ---- polling: /data (shape changes) + the visible rows
    startPolling(function () {
      return getJSON('/data').then(function (next) {
        if (next.kind !== 'database') return;
        var sig = JSON.stringify([next.columns, next.view]);
        var oldSig = JSON.stringify([data.columns, data.view]);
        state.refreshed = Date.now();
        if (sig !== oldSig) {
          // Columns/view changed: rebuild the whole page, keeping search + sort.
          stopPolling();
          closePanel();
          content.destroy();
          startDatabase(next);
          return;
        }
        db.total = typeof next.row_count === 'number' ? next.row_count : db.total;
        return content.refresh(next.row_count);
      }, function (err) { if (err && err.notFound) showNotAvailable(); });
    });
  }

  // ------------------------------------------------------------------ boot

  function boot() {
    if (!TOKEN) return showNotAvailable();
    if (!window.marked || !window.DOMPurify) {
      return showStatus('Something went wrong', 'The viewer could not start.', function () { location.reload(); });
    }
    clear(appEl);
    appEl.appendChild(h('div', { class: 'status' }, [h('p', { text: 'Loading…' })]));
    getJSON('/data').then(function (data) {
      if (data && data.kind === 'database') startDatabase(data);
      else if (data && data.kind === 'draft') startDraft(data);
      else showStatus('Something went wrong', 'This share has an unknown format.');
    }, function (err) { showFailure(err, boot); });
  }

  boot();
})();
