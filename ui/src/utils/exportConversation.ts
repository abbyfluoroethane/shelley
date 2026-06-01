// Open a self-contained "Export Conversation" view in a new browser tab.
//
// The exported page is a single, dependency-light HTML document: the left
// pane is an editable Markdown source textarea, the right pane is a live
// rendered preview. Both panes have copy + download buttons, and the whole
// layout is responsive (side-by-side on desktop, tabbed on mobile).
//
// Everything runs on the client. We render Markdown with `marked` and
// sanitize with `DOMPurify`, loaded from a CDN inside the new tab so the
// exported document stays standalone (it doesn't depend on the app bundle).
import { Conversation, Message } from "../types";
import { conversationToMarkdown } from "./conversationMarkdown";

function filenameFor(conversation: Conversation | undefined): string {
  const base = (conversation?.slug || "conversation")
    .replace(/[^a-z0-9-_]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${base || "conversation"}.md`;
}

// Build the full standalone HTML document for the export tab.
function buildExportDocument(
  title: string,
  withTools: string,
  withoutTools: string,
  filename: string,
): string {
  // Embed payload as JSON in a script tag to avoid any escaping pitfalls.
  // We ship both the with-tools and without-tools renderings so the
  // "Include tool outputs" checkbox can swap between them client-side
  // without re-running the conversion (the page is standalone).
  // `css` is embedded so the "Download .html" action can produce a styled,
  // standalone file (it reuses the preview's markdown-body styling).
  const payload = JSON.stringify({ withTools, withoutTools, filename, title, css: EXPORT_CSS })
    // Guard against an inline </script> in the data closing our tag early.
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} — Export</title>
<style>${EXPORT_CSS}</style>
</head>
<body>
<header class="bar">
  <div class="bar-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
  <label class="opt"><input type="checkbox" id="include-tools" checked /> Include tool outputs</label>
  <div class="tabs" role="tablist">
    <button class="tab tab-active" data-pane="edit" role="tab">Markdown</button>
    <button class="tab" data-pane="preview" role="tab">Preview</button>
  </div>
</header>
<main class="panes">
  <section class="pane pane-edit" aria-label="Markdown source">
    <div class="pane-head">
      <span class="pane-label">Markdown</span>
      <div class="pane-actions">
        <button class="btn" id="copy-md">Copy</button>
        <button class="btn btn-primary" id="download-md">Download .md</button>
      </div>
    </div>
    <textarea id="src" spellcheck="false" aria-label="Editable markdown"></textarea>
  </section>
  <section class="pane pane-preview" aria-label="Rendered preview">
    <div class="pane-head">
      <span class="pane-label">Preview</span>
      <div class="pane-actions">
        <button class="btn" id="copy-rich">Copy</button>
        <button class="btn" id="download-html">Download .html</button>
      </div>
    </div>
    <article id="preview" class="markdown-body"></article>
  </section>
</main>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script id="payload" type="application/json">${payload}</script>
<script src="https://cdn.jsdelivr.net/npm/marked@17.0.3/lib/marked.umd.js"></script>
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.3.1/dist/purify.min.js"></script>
<script>${EXPORT_JS}</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Open the export view for the given conversation + message history.
export function openConversationExport(
  conversation: Conversation | undefined,
  messages: Message[],
): void {
  const withTools = conversationToMarkdown(conversation, messages, { includeToolOutputs: true });
  const withoutTools = conversationToMarkdown(conversation, messages, {
    includeToolOutputs: false,
  });
  const title = conversation?.slug || "Conversation";
  const filename = filenameFor(conversation);
  const html = buildExportDocument(title, withTools, withoutTools, filename);

  // Open the tab synchronously (within the click handler) so popup blockers
  // allow it, then stream the document in. Use a Blob URL so the page has a
  // stable URL the user can bookmark/refresh without re-running the app.
  //
  // Note: we intentionally do NOT pass "noopener" here. Per spec, window.open
  // returns null when noopener is set, which would make the popup-blocked
  // detection below fire on every (successful) export. The opened document is
  // one we generate ourselves on a same-origin blob: URL, so severing
  // window.opener isn't needed for safety; we clear it defensively instead.
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, "_blank");
  if (win) {
    try {
      win.opener = null;
    } catch {
      // Cross-origin or detached window; ignore.
    }
  } else {
    // Popup blocked: fall back to a direct download of the markdown.
    const dl = document.createElement("a");
    dl.href = URL.createObjectURL(new Blob([withTools], { type: "text/markdown" }));
    dl.download = filename;
    dl.click();
    URL.revokeObjectURL(dl.href);
  }
  // Revoke the blob URL after the new tab has had time to load it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------------------------------------------------------------------------
// Standalone page assets (injected verbatim into the exported document).
// ---------------------------------------------------------------------------

const EXPORT_CSS = `
:root {
  --bg: #ffffff; --fg: #1a1a1a; --muted: #6b7280; --border: #e5e7eb;
  --panel: #f9fafb; --accent: #2563eb; --accent-fg: #ffffff; --code-bg: #f3f4f6;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115; --fg: #e6e6e6; --muted: #9aa0aa; --border: #2a2f3a;
    --panel: #161922; --accent: #3b82f6; --accent-fg: #ffffff; --code-bg: #1c2029;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  display: flex; flex-direction: column; background: var(--bg); color: var(--fg);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
.bar {
  display: flex; align-items: center; gap: 12px; padding: 8px 14px;
  border-bottom: 1px solid var(--border); background: var(--panel); flex: 0 0 auto;
}
.bar-title {
  font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  flex: 1 1 auto; min-width: 0;
}
.opt { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--muted); white-space: nowrap; cursor: pointer; }
.opt input { cursor: pointer; }
.tabs { display: none; gap: 4px; }
.tab {
  border: 1px solid var(--border); background: var(--bg); color: var(--fg);
  padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px;
}
.tab-active { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
.panes { display: flex; flex: 1 1 auto; min-height: 0; }
.pane {
  display: flex; flex-direction: column; flex: 1 1 50%; min-width: 0; min-height: 0;
}
.pane-edit { border-right: 1px solid var(--border); }
.pane-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 8px 12px; border-bottom: 1px solid var(--border); background: var(--panel);
  flex: 0 0 auto;
}
.pane-label { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.pane-actions { display: flex; gap: 6px; }
.btn {
  border: 1px solid var(--border); background: var(--bg); color: var(--fg);
  padding: 5px 11px; border-radius: 6px; cursor: pointer; font-size: 13px; white-space: nowrap;
}
.btn:hover { border-color: var(--accent); }
.btn-primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); }
#src {
  flex: 1 1 auto; width: 100%; border: 0; resize: none; padding: 16px;
  font: 13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  background: var(--bg); color: var(--fg); outline: none; tab-size: 2;
}
#preview { flex: 1 1 auto; overflow: auto; padding: 16px 22px; }
.toast {
  position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%) translateY(20px);
  background: var(--fg); color: var(--bg); padding: 8px 16px; border-radius: 8px;
  font-size: 13px; opacity: 0; pointer-events: none; transition: opacity .2s, transform .2s;
}
.toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
/* Markdown typography */
.markdown-body h1, .markdown-body h2, .markdown-body h3 { line-height: 1.25; margin: 1.2em 0 .5em; }
.markdown-body h1 { font-size: 1.7em; border-bottom: 1px solid var(--border); padding-bottom: .2em; }
.markdown-body h2 { font-size: 1.35em; border-bottom: 1px solid var(--border); padding-bottom: .2em; }
.markdown-body h3 { font-size: 1.12em; }
.markdown-body p { margin: .6em 0; }
.markdown-body pre {
  background: var(--code-bg); padding: 12px 14px; border-radius: 8px; overflow: auto;
  font: 12.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.markdown-body code {
  background: var(--code-bg); padding: .15em .35em; border-radius: 4px;
  font: 0.9em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.markdown-body pre code { background: none; padding: 0; }
.markdown-body blockquote {
  margin: .6em 0; padding: .2em 1em; border-left: 3px solid var(--border); color: var(--muted);
}
.markdown-body table { border-collapse: collapse; margin: .6em 0; }
.markdown-body th, .markdown-body td { border: 1px solid var(--border); padding: 6px 10px; }
.markdown-body details { margin: .5em 0; }
.markdown-body summary { cursor: pointer; color: var(--muted); }
.markdown-body img { max-width: 100%; }
.markdown-body a { color: var(--accent); }
@media (max-width: 720px) {
  .tabs { display: flex; }
  .pane { flex-basis: 100%; }
  .pane-edit { border-right: 0; }
  .panes .pane { display: none; }
  .panes .pane.pane-shown { display: flex; }
}
`;

const EXPORT_JS = `
(function () {
  var data = JSON.parse(document.getElementById('payload').textContent);
  var src = document.getElementById('src');
  var preview = document.getElementById('preview');
  var toastEl = document.getElementById('toast');
  var includeTools = document.getElementById('include-tools');
  // Track whether the user has hand-edited the markdown, so toggling the
  // "include tool outputs" checkbox doesn't silently clobber their edits.
  var edited = false;
  src.value = data.withTools;
  document.title = data.title + ' \u2014 Export';

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastEl._t);
    toastEl._t = setTimeout(function () { toastEl.classList.remove('show'); }, 1600);
  }

  function render() {
    var md = src.value;
    var html;
    try {
      if (window.marked) {
        var parse = window.marked.parse || (window.marked.marked && window.marked.marked.parse);
        html = parse ? parse(md, { gfm: true, breaks: true }) : null;
      }
    } catch (e) { html = null; }
    if (html == null) {
      // Fallback: show escaped source if the renderer failed to load.
      var pre = document.createElement('pre');
      pre.textContent = md;
      preview.innerHTML = '';
      preview.appendChild(pre);
      return;
    }
    if (window.DOMPurify) {
      html = window.DOMPurify.sanitize(html, { ADD_TAGS: ['details', 'summary'] });
    }
    preview.innerHTML = html;
  }

  var raf;
  src.addEventListener('input', function () {
    edited = true;
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(render);
  });

  includeTools.addEventListener('change', function () {
    var next = includeTools.checked ? data.withTools : data.withoutTools;
    if (edited && src.value !== data.withTools && src.value !== data.withoutTools) {
      if (!confirm('Switching tool outputs will discard your edits. Continue?')) {
        includeTools.checked = !includeTools.checked;
        return;
      }
    }
    src.value = next;
    edited = false;
    render();
  });

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta); resolve();
      } catch (e) { reject(e); }
    });
  }

  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  document.getElementById('copy-md').addEventListener('click', function () {
    copy(src.value).then(function () { toast('Markdown copied'); }, function () { toast('Copy failed'); });
  });
  document.getElementById('download-md').addEventListener('click', function () {
    download(data.filename, src.value, 'text/markdown');
    toast('Downloaded ' + data.filename);
  });
  document.getElementById('copy-rich').addEventListener('click', function () {
    // Prefer rich HTML on the clipboard, with a plain-text markdown fallback.
    var html = preview.innerHTML;
    if (navigator.clipboard && window.ClipboardItem) {
      var item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([src.value], { type: 'text/plain' })
      });
      navigator.clipboard.write([item]).then(
        function () { toast('Rendered copied'); },
        function () { copy(preview.innerText).then(function () { toast('Copied as text'); }); }
      );
    } else {
      copy(preview.innerText).then(function () { toast('Copied as text'); }, function () { toast('Copy failed'); });
    }
  });
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  document.getElementById('download-html').addEventListener('click', function () {
    var doc = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>' + escapeHtml(data.title) + '</title>' +
      '<style>' + data.css + ' body{padding:24px;max-width:860px;margin:0 auto;}</style>' +
      '</head><body class="markdown-body">' + preview.innerHTML + '</body></html>';
    download(data.filename.replace(/\\.md$/, '') + '.html', doc, 'text/html');
    toast('Downloaded HTML');
  });

  // Mobile tab switching.
  var tabs = document.querySelectorAll('.tab');
  var paneEdit = document.querySelector('.pane-edit');
  var panePreview = document.querySelector('.pane-preview');
  function showPane(which) {
    tabs.forEach(function (t) { t.classList.toggle('tab-active', t.getAttribute('data-pane') === which); });
    paneEdit.classList.toggle('pane-shown', which === 'edit');
    panePreview.classList.toggle('pane-shown', which === 'preview');
  }
  tabs.forEach(function (t) {
    t.addEventListener('click', function () { showPane(t.getAttribute('data-pane')); });
  });
  showPane('edit');

  render();
})();
`;
