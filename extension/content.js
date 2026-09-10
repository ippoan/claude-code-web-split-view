// claude.ai/code に Claude Code desktop 風の「分割画面」を足す content script。
//
// 仕組み (2026-09-10 実測):
//   claude.ai の CSP は `frame-ancestors 'self'` なので、claude.ai 自身のページからなら
//   同一オリジン iframe で /code/session_… を開ける (拡張ページ・sidePanel からは弾かれる)。
//   そこで #root を左に縮め、右に position:fixed のペイン群を置き、各ペインに iframe を入れる。
//   iframe 内のセッション画面はサイドバー無しで描画される (幅 756〜1200px で確認)。
//
// 操作:
//   - サイドバーのセッションを Ctrl / ⌘ + クリック → 右ペインに開く (desktop 版と同じ操作)
//   - セッション行の右端の ⧉ → 同じ
//   - ペイン上部: ⇄ (メインと入れ替え) / ↗ (メインで開く) / × (閉じる)
//   - 左端の縦バーをドラッグ → ペイン幅を変える
//   ペイン構成は chrome.storage.local に残り、リロードで復元する。
//
// javascript_tool (Claude in Chrome) からそのまま流し込んで試験できるよう、chrome.storage が
// 無い環境では localStorage に落ちる。
(() => {
  'use strict';
  if (window.__ccwSplitLoaded) return;
  window.__ccwSplitLoaded = true;

  const ORIGIN = location.origin;
  const SESSION_RE = /^\/code\/(session_[A-Za-z0-9]+)\/?$/;
  const isTop = (() => { try { return window.top === window; } catch { return false; } })();
  const sessionPath = (href) => {
    try { const u = new URL(href, ORIGIN); if (u.origin !== ORIGIN) return null; const m = u.pathname.match(SESSION_RE); return m ? `/code/${m[1]}` : null; } catch { return null; }
  };
  const linkTitle = (a) => {
    if (a.getAttribute('aria-label')) return a.getAttribute('aria-label').trim().slice(0, 80);
    const c = a.cloneNode(true); c.querySelectorAll('.ccw-open').forEach((x) => x.remove());
    return (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  };

  // ---- storage --------------------------------------------------------------
  const hasChromeStorage = (() => { try { return !!(globalThis.chrome && chrome.storage && chrome.storage.local); } catch { return false; } })();
  const store = {
    async get(key, dflt) {
      if (hasChromeStorage) { try { const o = await chrome.storage.local.get(key); return o[key] ?? dflt; } catch { } }
      try { const v = localStorage.getItem('ccw:' + key); return v ? JSON.parse(v) : dflt; } catch { return dflt; }
    },
    async set(key, val) {
      if (hasChromeStorage) { try { await chrome.storage.local.set({ [key]: val }); return; } catch { } }
      try { localStorage.setItem('ccw:' + key, JSON.stringify(val)); } catch { }
    },
  };

  // ---- iframe 側 (ペインの中) ------------------------------------------------
  if (!isTop) {
    document.documentElement.dataset.ccwPane = '1';
    // Ctrl/⌘+クリックは親に上げて新しいペインにする (iframe の中に iframe を作らない)
    document.addEventListener('click', (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      const p = sessionPath(a.href); if (!p) return;
      e.preventDefault(); e.stopPropagation();
      window.top.postMessage({ type: 'ccw:open', path: p, title: linkTitle(a) }, ORIGIN);
    }, true);
    // ペイン内で別セッションへ遷移したら親に知らせる (復元用)。SPA なので pathname を見張る
    let last = location.pathname;
    const report = () => { window.top.postMessage({ type: 'ccw:nav', path: location.pathname, title: document.title }, ORIGIN); };
    report();
    setInterval(() => { if (location.pathname !== last) { last = location.pathname; report(); } }, 1000);
    return;
  }

  // ---- top 側 -----------------------------------------------------------------
  const CSS = `
html.ccw-active #root { width: calc(100% - var(--ccw-w, 50vw)) !important; }
#ccw-split { position: fixed; top: 0; right: 0; height: 100vh; width: var(--ccw-w, 50vw); z-index: 2147483000;
  display: flex; background: var(--cds-surface-1, #1f1e1b); color: var(--cds-text-primary, #eee);
  font: 12px/1.4 system-ui, sans-serif; box-shadow: -1px 0 0 rgba(128,128,128,.35); }
#ccw-split[hidden] { display: none; }
#ccw-split .ccw-handle { flex: 0 0 6px; cursor: col-resize; background: transparent; }
#ccw-split .ccw-handle:hover, html.ccw-dragging #ccw-split .ccw-handle { background: rgba(128,128,128,.35); }
#ccw-split .ccw-panes { flex: 1; display: flex; min-width: 0; overflow-x: auto; }
#ccw-split .ccw-pane { flex: 1 1 0; min-width: 360px; display: flex; flex-direction: column; border-left: 1px solid rgba(128,128,128,.25); }
#ccw-split .ccw-pane:first-child { border-left: 0; }
#ccw-split .ccw-bar { flex: 0 0 auto; display: flex; align-items: center; gap: 4px; padding: 2px 6px; background: rgba(128,128,128,.12); }
#ccw-split .ccw-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .85; }
#ccw-split .ccw-bar button { all: unset; cursor: pointer; padding: 0 5px; border-radius: 4px; opacity: .7; }
#ccw-split .ccw-bar button:hover { opacity: 1; background: rgba(128,128,128,.25); }
#ccw-split iframe { flex: 1; width: 100%; border: 0; background: transparent; }
html.ccw-dragging #ccw-split iframe, html.ccw-dragging #root { pointer-events: none; user-select: none; }
a[href^="/code/session_"] .ccw-open { margin-left: auto; margin-right: calc(var(--df-row-ctl, 24px) + 6px); padding: 0 4px; opacity: 0; font-size: 11px; line-height: 1; border-radius: 3px; }
a[href^="/code/session_"]:hover .ccw-open { opacity: .6; }
a[href^="/code/session_"] .ccw-open:hover { opacity: 1; background: rgba(128,128,128,.3); }
`;

  const state = { panes: [], frac: 0.5 };   // panes: [{ path, title }], frac: ペイン領域の横幅比
  let box = null, panesEl = null;

  const save = () => store.set('split', { panes: state.panes, frac: state.frac });
  const applyWidth = () => { document.documentElement.style.setProperty('--ccw-w', `${Math.round(state.frac * 10000) / 100}vw`); };

  function ensureBox() {
    if (box) return box;
    if (!document.getElementById('ccw-style')) { const s = document.createElement('style'); s.id = 'ccw-style'; s.textContent = CSS; document.documentElement.appendChild(s); }
    box = document.createElement('div'); box.id = 'ccw-split'; box.hidden = true;
    const handle = document.createElement('div'); handle.className = 'ccw-handle'; handle.title = 'ドラッグで幅を変える';
    panesEl = document.createElement('div'); panesEl.className = 'ccw-panes';
    box.append(handle, panesEl);
    document.body.appendChild(box);
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      document.documentElement.classList.add('ccw-dragging');
      const move = (ev) => { state.frac = Math.min(0.85, Math.max(0.15, (window.innerWidth - ev.clientX) / window.innerWidth)); applyWidth(); };
      const up = () => { document.documentElement.classList.remove('ccw-dragging'); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); save(); };
      document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
    });
    return box;
  }

  function render() {
    ensureBox();
    const active = state.panes.length > 0;
    document.documentElement.classList.toggle('ccw-active', active);
    box.hidden = !active;
    applyWidth();
    // 既存の iframe は作り直さない (再読込されるので)。path が一致する要素を使い回す
    const old = new Map([...panesEl.children].map((el) => [el.dataset.path, el]));
    panesEl.replaceChildren(...state.panes.map((p) => {
      let el = old.get(p.path);
      if (!el) el = makePane(p);
      else { old.delete(p.path); el.querySelector('.ccw-title').textContent = p.title || p.path; }
      return el;
    }));
  }

  function makePane(p) {
    const el = document.createElement('div'); el.className = 'ccw-pane'; el.dataset.path = p.path;
    const bar = document.createElement('div'); bar.className = 'ccw-bar';
    const title = document.createElement('span'); title.className = 'ccw-title'; title.textContent = p.title || p.path;
    const btn = (label, tip, fn) => { const b = document.createElement('button'); b.textContent = label; b.title = tip; b.addEventListener('click', fn); return b; };
    bar.append(title,
      btn('⇄', 'メインと入れ替える', () => swapWithMain(el.dataset.path)),
      btn('↗', 'メインで開く (ペインは閉じる)', () => { const path = el.dataset.path; closePane(path); location.assign(path); }),
      btn('×', '閉じる', () => closePane(el.dataset.path)));
    const f = document.createElement('iframe'); f.src = p.path; f.setAttribute('allow', 'clipboard-read; clipboard-write; microphone');
    el.append(bar, f);
    return el;
  }

  function openPane(path, title) {
    if (!path) return;
    if (path === location.pathname) return;               // メインに出ているものは開かない
    const i = state.panes.findIndex((p) => p.path === path);
    if (i >= 0) { state.panes[i].title = title || state.panes[i].title; }
    else state.panes.push({ path, title: title || path });
    render(); save();
  }
  function closePane(path) { state.panes = state.panes.filter((p) => p.path !== path); render(); save(); }
  function swapWithMain(path) {
    const main = sessionPath(location.href);
    const pane = state.panes.find((p) => p.path === path);
    if (!pane) return;
    if (main) { const mainTitle = currentMainTitle(); pane.path = main; pane.title = mainTitle || main; const el = panesEl.querySelector(`.ccw-pane[data-path="${CSS_escape(path)}"]`); if (el) { el.dataset.path = main; el.querySelector('iframe').src = main; } }
    else closePane(path);
    save();
    location.assign(path);
  }
  const CSS_escape = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&');
  const currentMainTitle = () => { const a = document.querySelector(`a[href="${CSS_escape(location.pathname)}"]`); return a ? linkTitle(a) : ''; };

  // ---- 入口: Ctrl/⌘+クリック、行末の ⧉、iframe からの postMessage ---------------
  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const p = sessionPath(a.href); if (!p) return;
    const viaButton = e.target.closest && e.target.closest('.ccw-open');
    if (!viaButton && !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault(); e.stopPropagation();
    openPane(p, linkTitle(a));
  }, true);

  window.addEventListener('message', (e) => {
    if (e.origin !== ORIGIN || !e.data || typeof e.data.type !== 'string') return;
    if (e.data.type === 'ccw:open') openPane(sessionPath(e.data.path), e.data.title);
    if (e.data.type === 'ccw:nav') {
      // どのペインからか = source window で引く
      const el = [...panesEl?.children || []].find((x) => x.querySelector('iframe')?.contentWindow === e.source);
      const p = el && state.panes.find((x) => x.path === el.dataset.path);
      const np = sessionPath(e.data.path);
      if (p && np && np !== p.path) { p.path = np; el.dataset.path = np; const a = document.querySelector(`a[href="${CSS_escape(np)}"]`); p.title = a ? linkTitle(a) : np; el.querySelector('.ccw-title').textContent = p.title; save(); }
    }
  });

  // サイドバーのセッション行に ⧉ を足す (React の再描画で消えたら足し直す)。
  // 行の右端には claude.ai 自身のホバー操作ボタン (<a> の兄弟、absolute、幅 --df-row-ctl) が乗るので、
  // ⧉ はその左に margin-right で逃がす (重なると押し分けられない — 2026-09-10 実機で指摘)
  const decorate = () => {
    for (const a of document.querySelectorAll('a[href^="/code/session_"]')) {
      if (a.querySelector('.ccw-open') || a.closest('#ccw-split')) continue;
      const s = document.createElement('span'); s.className = 'ccw-open'; s.title = '右のペインで開く (Ctrl/⌘+クリックでも)'; s.textContent = '⧉';
      a.appendChild(s);
    }
  };
  let pending = false;
  new MutationObserver(() => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; decorate(); }); }).observe(document.documentElement, { childList: true, subtree: true });

  // ---- 復元 ----------------------------------------------------------------------
  (async () => {
    const saved = await store.get('split', null);
    if (saved && Array.isArray(saved.panes)) {
      state.panes = saved.panes.filter((p) => p && sessionPath(p.path)).map((p) => ({ path: sessionPath(p.path), title: p.title || '' }));
      if (typeof saved.frac === 'number') state.frac = Math.min(0.85, Math.max(0.15, saved.frac));
    }
    // メインで開いているセッションと同じペインは要らない
    state.panes = state.panes.filter((p) => p.path !== location.pathname);
    decorate();
    if (state.panes.length) render();
  })();

  // 試験・デバッグ用の口 (javascript_tool から window.ccwSplit.open('/code/session_…'))
  window.ccwSplit = { open: openPane, close: closePane, state, render };
})();
