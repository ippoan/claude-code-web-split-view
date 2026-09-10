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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- タイトル規約 (ippoan/claude-skills task-split §1) ------------------------------
  //   親:  #p<issue> <題>            → Opus (Fable でも可)
  //   子:  [S]/[O] #c<issue>-<n> <題>  または  [S]/[O] #p<issue>-c<子issue> <題>
  //        [S] = Sonnet、それ以外 (= 既定) は Opus
  //   [旧] #p… は交代前の旧親 (何もしない)
  const parseTitle = (t) => {
    const s = String(t || '').trim();
    const m0 = s.match(/^\[(S|O|旧)\]\s*/i);
    const tag = m0 ? m0[1].toUpperCase() : null;
    const rest = m0 ? s.slice(m0[0].length) : s;
    if (tag === '旧') return { role: 'old', issue: null, model: null };
    const model = tag === 'S' ? 'sonnet' : 'opus';
    let m;
    if ((m = rest.match(/^#p(\d+)-c\d+(\s|$)/))) return { role: 'child', issue: m[1], model };
    if ((m = rest.match(/^#c(\d+)-\d+(\s|$)/)))  return { role: 'child', issue: m[1], model };
    if ((m = rest.match(/^#p(\d+)(\s|$)/)))       return { role: 'parent', issue: m[1], model: 'opus' };
    return { role: null, issue: null, model: tag ? model : null };   // 規約外は触らない
  };

  // ---- モデルの強制 ---------------------------------------------------------------------
  // composer 右下の「モデル: Opus 5」ボタン → メニュー (role=menuitemradio: Fable 5.1 / Opus 5 / Sonnet 5 / Haiku 4.5)
  const MODEL_RULES = {
    sonnet: { ok: /^Sonnet/i, pick: /^Sonnet/i },
    opus:   { ok: /^(Opus|Fable)/i, pick: /^Opus/i },
  };
  const modelButton = () => [...document.querySelectorAll('button[aria-label]')].find((b) => /^(モデル|Model):/i.test(b.getAttribute('aria-label') || ''));
  const currentModel = () => { const b = modelButton(); return b ? (b.getAttribute('aria-label') || '').replace(/^(モデル|Model):\s*/i, '').trim() : null; };
  // 画面上部のセッション名ボタン (aria-label = "<題>、セッション名を変更")
  const headerTitle = () => {
    const b = [...document.querySelectorAll('button[aria-label]')].find((x) => /セッション名を変更$|rename/i.test(x.getAttribute('aria-label') || ''));
    if (!b) return '';
    return (b.getAttribute('aria-label') || '').replace(/、セッション名を変更$/, '').replace(/,?\s*rename( session)?$/i, '').trim();
  };
  let enforcing = false;
  const enforced = new Set();   // 決着がついた (期待どおりだった / 切り替えた / 規約外だった) セッション path
  // 決着がつくまで呼び直される前提 (15 秒おきの ticker + 遷移時)。題や composer がまだ無い回は何も決めない
  // (v0.0.8〜0.0.10 は 1 回きりで、描画前に「規約外」と決めて二度と見なかった → 切り替わらないペインが出た)
  async function enforceModel(path, title, why) {
    if (!path || enforced.has(path) || enforcing) return null;
    if (!title) return null;                                   // 題がまだ取れていない → 次回
    const want = parseTitle(title).model;
    if (!want) { enforced.add(path); return null; }            // 規約外 → 触らない (決着)
    const cur = currentModel();
    if (!cur) return null;                                     // composer がまだ無い → 次回
    const rule = MODEL_RULES[want];
    if (rule.ok.test(cur)) { enforced.add(path); return null; } // 期待どおり (決着)
    enforcing = true;
    try {
      const btn = modelButton(); btn.click();
      await sleep(600);
      const item = [...document.querySelectorAll('[role="menuitemradio"]')].find((e) => rule.pick.test((e.innerText || '').trim()));
      if (!item) { btn.click(); console.warn('[ccw] model menu item not found for', want, '(retry later)'); return null; }
      item.click();
      await sleep(600);
      const after = currentModel();
      console.log('[ccw] model', cur, '->', after, 'by title', JSON.stringify(title), why);
      if (after && rule.ok.test(after)) enforced.add(path);   // 切り替わった (決着)。失敗なら次回
      return after;
    } finally { enforcing = false; }
  }

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
    const enforceHere = () => { const p = sessionPath(location.href); if (p) enforceModel(p, headerTitle(), 'pane'); };
    report(); sleep(2000).then(enforceHere);
    setInterval(() => { if (location.pathname !== last) { last = location.pathname; report(); enforceHere(); } }, 1000);
    setInterval(enforceHere, 15000);   // 決着がつくまで呼び直す (決着後は即 return)
    return;
  }

  // ---- top 側 -----------------------------------------------------------------
  const CSS = `
html.ccw-active #root { width: calc(100% - var(--ccw-w, 50vw)) !important; }
#ccw-split { position: fixed; top: 0; right: 0; height: 100vh; width: var(--ccw-w, 50vw); z-index: 2147483000;
  display: flex; background: var(--cds-surface-1, #1f1e1b); color: var(--cds-text-primary, #eee);
  font: 12px/1.4 system-ui, sans-serif; box-shadow: -1px 0 0 rgba(128,128,128,.35); }
#ccw-split[hidden] { display: none; }
#ccw-split .ccw-handle { flex: 0 0 16px; cursor: col-resize; background: transparent; display: flex; flex-direction: column; align-items: center; gap: 2px; padding-top: 4px; box-sizing: border-box; }
#ccw-split .ccw-handle:hover, html.ccw-dragging #ccw-split .ccw-handle { background: rgba(128,128,128,.2); }
#ccw-split .ccw-handle button { all: unset; cursor: pointer; font-size: 12px; line-height: 1; padding: 4px 2px; opacity: .6; border-radius: 3px; }
#ccw-split .ccw-handle button:hover { opacity: 1; background: rgba(128,128,128,.35); }
/* 親 (メイン) を畳む: #root を 0 幅にしてペインに全部渡す。戻すのは縦バーの ⇥ */
html.ccw-main-collapsed #root { width: 0 !important; overflow: hidden !important; }
html.ccw-main-collapsed #ccw-split { width: 100vw; }
/* サイドバー上部 (desktop と同じ位置) の畳むボタン。claude.ai 自身の「サイドバーを非表示」を押すだけ */
.ccw-sb-toggle { all: unset; cursor: pointer; margin-right: 8px; padding: 3px 6px; border-radius: 6px; opacity: .7; font-size: 13px; line-height: 1; }
.ccw-sb-toggle:hover { opacity: 1; background: rgba(128,128,128,.25); }
#ccw-split .ccw-panes { flex: 1; display: flex; min-width: 0; overflow-x: auto; }
#ccw-split .ccw-pane { flex: 1 1 0; min-width: 360px; display: flex; flex-direction: column; border-left: 1px solid rgba(128,128,128,.25); }
#ccw-split .ccw-pane:first-child { border-left: 0; }
#ccw-split .ccw-bar { flex: 0 0 auto; display: flex; align-items: center; gap: 4px; padding: 2px 6px; background: rgba(128,128,128,.12); }
#ccw-split .ccw-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .85; }
#ccw-split .ccw-bar button { all: unset; cursor: pointer; padding: 0 5px; border-radius: 4px; opacity: .7; }
#ccw-split .ccw-bar button:hover { opacity: 1; background: rgba(128,128,128,.25); }
#ccw-split iframe { flex: 1; width: 100%; border: 0; background: transparent; }
html.ccw-dragging #ccw-split iframe, html.ccw-dragging #root { pointer-events: none; user-select: none; }
a[href^="/code/session_"] .ccw-open { margin-left: auto; margin-right: calc(var(--df-row-ctl, 24px) + 6px); padding: 0 4px; opacity: .35; font-size: 11px; line-height: 1; border-radius: 3px; }
a[href^="/code/session_"]:hover .ccw-open { opacity: .7; }
a[href^="/code/session_"] .ccw-open:hover { opacity: 1; background: rgba(128,128,128,.3); }
a[href^="/code/session_"] .ccw-group { padding: 0 4px; opacity: .35; font-size: 11px; line-height: 1; border-radius: 3px; }
a[href^="/code/session_"]:hover .ccw-group { opacity: .7; }
a[href^="/code/session_"] .ccw-group:hover { opacity: 1; background: rgba(128,128,128,.3); }
/* ペインで開いているセッションの行 (= <a> の親の .group) に、claude.ai 自身の選択色を当てる (desktop 版の横並び時と同じ見え方) */
.ccw-in-pane { background: var(--df-selected, rgba(255,255,255,.15)) !important; }
.ccw-in-pane .ccw-open { opacity: 1; }
`;

  const state = { panes: [], frac: 0.5, mainCollapsed: false };   // panes: [{ path, title }], frac: ペイン領域の横幅比
  let box = null, panesEl = null;

  const save = () => store.set('split', { panes: state.panes, frac: state.frac, mainCollapsed: state.mainCollapsed });
  const applyWidth = () => {
    document.documentElement.classList.toggle('ccw-main-collapsed', state.mainCollapsed && state.panes.length > 0);
    document.documentElement.style.setProperty('--ccw-w', state.mainCollapsed ? '100vw' : `${Math.round(state.frac * 10000) / 100}vw`);
    if (mainBtn) { mainBtn.textContent = state.mainCollapsed ? '⇥' : '⇤'; mainBtn.title = state.mainCollapsed ? '親 (メイン) を戻す' : '親 (メイン) を畳んでペインに幅を渡す'; }
  };
  // claude.ai 自身のサイドバー開閉ボタン (隠すと左上に「サイドバーを表示」が出る)
  const nativeSidebarBtn = (which) => [...document.querySelectorAll('button[aria-label]')].find((b) => (which === 'hide' ? /サイドバーを非表示|hide sidebar/i : /サイドバーを表示|show sidebar/i).test(b.getAttribute('aria-label') || ''));
  const toggleSidebar = () => { const b = nativeSidebarBtn('hide') || nativeSidebarBtn('show'); if (b) b.click(); };
  let mainBtn = null;

  // CSS は最初に入れる (ペインを開くまで入れずにいると ⧉ の位置・濃さのルールが効かない — v0.0.1〜0.0.4 の実害)
  const ensureStyle = () => { if (!document.getElementById('ccw-style')) { const s = document.createElement('style'); s.id = 'ccw-style'; s.textContent = CSS; document.documentElement.appendChild(s); } };
  ensureStyle();

  function ensureBox() {
    if (box) return box;
    ensureStyle();
    box = document.createElement('div'); box.id = 'ccw-split'; box.hidden = true;
    const handle = document.createElement('div'); handle.className = 'ccw-handle'; handle.title = 'ドラッグで幅を変える';
    mainBtn = document.createElement('button'); mainBtn.addEventListener('click', (e) => { e.stopPropagation(); state.mainCollapsed = !state.mainCollapsed; applyWidth(); save(); });
    const sbBtn = document.createElement('button'); sbBtn.textContent = '▤'; sbBtn.title = 'サイドバーを畳む / 戻す'; sbBtn.addEventListener('click', (e) => { e.stopPropagation(); if (state.mainCollapsed) { state.mainCollapsed = false; applyWidth(); save(); } toggleSidebar(); });
    handle.append(mainBtn, sbBtn);
    panesEl = document.createElement('div'); panesEl.className = 'ccw-panes';
    box.append(handle, panesEl);
    document.body.appendChild(box);
    handle.addEventListener('mousedown', (e) => {
      if (e.target.closest('button') || state.mainCollapsed) return;
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
    decorate();   // 開閉に合わせてサイドバーの行色を更新
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
      btn('×', '閉じる', () => { dismiss(el.dataset.path); closePane(el.dataset.path); }));
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
    if (e.target.closest && e.target.closest('.ccw-group')) {
      e.preventDefault(); e.stopPropagation();
      const info = parseTitle(linkTitle(a));
      if (info.issue) openGroup(info.issue, { includeParent: p !== location.pathname });
      return;
    }
    const viaButton = e.target.closest && e.target.closest('.ccw-open');
    if (!viaButton && !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault(); e.stopPropagation();
    openPane(p, linkTitle(a));
  }, true);

  // ---- 親子グループ ------------------------------------------------------------------------
  const sidebarSessions = () => [...document.querySelectorAll('a[href^="/code/session_"]')].filter((a) => !a.closest('#ccw-split'))
    .map((a) => { const title = linkTitle(a); return { a, path: sessionPath(a.href), title, info: parseTitle(title) }; }).filter((x) => x.path);
  const sessionTitleFor = (path) => { const x = sidebarSessions().find((y) => y.path === path); return x ? x.title : headerTitle(); };
  // 同じ issue の親と子をまとめて右に開く (親が既にメインならそれは除く)
  function openGroup(issue, { includeParent }) {
    const members = sidebarSessions().filter((x) => x.info.issue === issue && x.info.role !== 'old');
    const parent = members.find((x) => x.info.role === 'parent');
    const children = members.filter((x) => x.info.role === 'child');
    if (includeParent && parent) openPane(parent.path, parent.title);
    for (const c of children) openPane(c.path, c.title);
  }
  // 親 (#p<issue>) をメインかペインで開いている間、サイドバーにあるその子のうちペインに出ていないものを開く
  // (起動時点で既にある子も対象 — ユーザー指示 2026-09-10)。× で閉じた子だけは、このページを開いている間は
  // 開き直さない (閉じた瞬間に開き直すと閉じられなくなる)。リロードすれば再び開く。
  // メモリ上だけに持つ (sessionStorage はリロードでも残るので、README の「リロードで再び開く」に合わせる)
  const dismissed = new Set();
  const dismiss = (path) => dismissed.add(path);
  const openParentIssues = () => {
    const issues = new Set();
    const main = sessionPath(location.href);
    if (main) { const i = parseTitle(sessionTitleFor(main)); if (i.role === 'parent') issues.add(i.issue); }
    for (const p of state.panes) { const i = parseTitle(p.title); if (i.role === 'parent') issues.add(i.issue); }
    return issues;
  };
  function autoOpenChildren(sessions) {
    const issues = openParentIssues(); if (!issues.size) return;
    for (const x of sessions) {
      if (x.info.role !== 'child' || !issues.has(x.info.issue)) continue;
      if (x.path === location.pathname || state.panes.some((p) => p.path === x.path) || dismissed.has(x.path)) continue;
      console.log('[ccw] open child of #p' + x.info.issue, '->', x.title);
      openPane(x.path, x.title);
    }
  }
  // メイン側のモデル強制 (決着がつくまで ticker から呼び直される)
  function enforceMain() {
    const main = sessionPath(location.href); if (!main) return;
    enforceModel(main, sessionTitleFor(main), 'main');
  }

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
  // サイドバー上部の「チャット / Code」切替の左に、畳むボタンを差し込む (desktop の位置に合わせる)
  const ensureSidebarToggle = () => {
    if (document.querySelector('.ccw-sb-toggle')) return;
    const radios = [...document.querySelectorAll('[role="radiogroup"]')];
    const mode = radios.find((g) => [...g.querySelectorAll('[role="radio"]')].some((r) => /^Code$/i.test(r.getAttribute('aria-label') || r.textContent || '')));
    if (!mode || !mode.parentElement) return;
    const b = document.createElement('button'); b.className = 'ccw-sb-toggle'; b.textContent = '▤'; b.title = 'サイドバーを畳む (戻すのは左上の「サイドバーを表示」)';
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleSidebar(); });
    mode.parentElement.insertBefore(b, mode);
  };

  const decorate = () => {
    try { ensureSidebarToggle(); } catch (e) { console.warn('[ccw] sidebar toggle', e); }
    const open = new Set(state.panes.map((p) => p.path));
    for (const a of document.querySelectorAll('a[href^="/code/session_"]')) {
      if (a.closest('#ccw-split')) continue;
      if (!a.querySelector('.ccw-open')) {
        const s = document.createElement('span'); s.className = 'ccw-open'; s.title = '右のペインで開く (Ctrl/⌘+クリックでも)'; s.textContent = '⧉';
        a.appendChild(s);
      }
      // 親 (#p<issue>) の行には「親と子をまとめて右に開く」⊞ を足す
      if (!a.querySelector('.ccw-group') && parseTitle(linkTitle(a)).role === 'parent') {
        const g = document.createElement('span'); g.className = 'ccw-group'; g.title = '親と子 (#c…/#p…-c…) をまとめて右に開く'; g.textContent = '⊞';
        a.insertBefore(g, a.querySelector('.ccw-open'));
      }
      // 行の色: ペインで開いている行に選択色 (React が再描画しても class は消えるだけなので毎回当て直す)
      if (a.parentElement) a.parentElement.classList.toggle('ccw-in-pane', open.has(sessionPath(a.href)));
    }
    try { autoOpenChildren(sidebarSessions()); } catch (e) { console.warn('[ccw] autoOpenChildren', e); }
  };
  let pending = false;
  new MutationObserver(() => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; decorate(); }); }).observe(document.documentElement, { childList: true, subtree: true });

  // ---- 復元 ----------------------------------------------------------------------
  (async () => {
    const saved = await store.get('split', null);
    if (saved && Array.isArray(saved.panes)) {
      state.panes = saved.panes.filter((p) => p && sessionPath(p.path)).map((p) => ({ path: sessionPath(p.path), title: p.title || '' }));
      if (typeof saved.frac === 'number') state.frac = Math.min(0.85, Math.max(0.15, saved.frac));
      state.mainCollapsed = !!saved.mainCollapsed;
    }
    // メインで開いているセッションと同じペインは要らない
    state.panes = state.panes.filter((p) => p.path !== location.pathname);
    decorate();
    if (state.panes.length) render();
    // サイドバーが出そろってから (React の初回描画待ち)
    for (let i = 0; i < 40 && !sidebarSessions().length; i++) await sleep(250);
    decorate(); enforceMain();
    // SPA 遷移 (サイドバーのクリック等) でメインが変わったらモデル判定をやり直す
    let lastPath = location.pathname;
    setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; decorate(); enforceMain(); } }, 1000);
    setInterval(enforceMain, 15000);   // 決着がつくまで呼び直す (決着後は即 return)
  })();

  // 試験・デバッグ用の口 (javascript_tool から window.ccwSplit.open('/code/session_…'))
  window.ccwSplit = { open: openPane, close: closePane, state, render };
})();
