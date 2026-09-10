// service worker: 自動更新まわりだけ (分割画面そのものは content.js)。
// 仕組みは ippoan/gh-actions-live と同じ 2 段:
//   ① installer/update.ps1 が GitHub Release の update.xml を見て extension\ を差し替える
//      (native messaging host 経由でボタン/コマンドから、または update.ps1 -Register でタスク登録)
//   ② ここが「ディスク上の manifest.json の版」と「動いている版」を比べ、違えば chrome.runtime.reload() する
//      (10 分ごとの alarm + 起動時 + アイコンを押したとき + ①の直後)
const REPO = 'ippoan/claude-code-web-split-view';
const NATIVE_HOST = 'jp.ippoan.claude_code_web_split_view';
const UPDATE_XML = `https://github.com/${REPO}/releases/latest/download/update.xml`;

const cmpVer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
const running = () => chrome.runtime.getManifest().version;

// 結果はユーザーに見える形で出す (無反応に見える、が v0.0.1〜0.0.3 の実害)
function notify(title, message) {
  try { chrome.notifications.create({ type: 'basic', iconUrl: 'icon128.png', title, message: String(message).slice(0, 400) }); } catch (e) { console.warn('[bg] notify', e); }
}

// ディスク上の版を読む (update.ps1 が差し替えた後は動いている版と違う)
async function diskVersion() {
  try { const r = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' }); return (await r.json()).version || null; }
  catch (e) { console.warn('[bg] diskVersion', e); return null; }
}

// ②: ディスク上の版が動いている版と違えば自分をリロード
async function checkDiskVersion(reason = '') {
  const onDisk = await diskVersion();
  if (!onDisk || onDisk === running()) return false;
  console.log('[bg] on-disk', onDisk, '!= running', running(), '-> reload', reason);
  await chrome.storage.local.set({ lastSelfUpdate: `${running()} -> ${onDisk}` });
  setTimeout(() => chrome.runtime.reload(), 300);
  return true;
}

// Release に新版があるか (badge に UP を出すだけ。取りに行くのは native host)
async function checkLatest() {
  try {
    const r = await fetch(UPDATE_XML, { cache: 'no-store' });
    if (!r.ok) return null;
    // <?xml version='1.0'?> を拾わないよう updatecheck 要素の version だけを見る (v0.0.4 で 1.0 と誤認してバッジが消えなかった)
    const m = (await r.text()).match(/<updatecheck\b[^>]*\sversion=['"]([0-9.]+)['"]/);
    const latest = m && m[1];
    const newer = !!latest && cmpVer(latest, running()) > 0;
    await chrome.action.setBadgeText({ text: newer ? 'UP' : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#da7756' });
    await chrome.storage.local.set({ latestVersion: latest || null });
    return newer ? latest : null;
  } catch (e) { console.warn('[bg] checkLatest', e); return null; }
}

async function nativeCall(cmd) {
  try { return await chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd }); }
  catch (e) { return { ok: false, noHost: true, error: (e && e.message) || String(e) }; }
}

// ①をボタンから起動する: native host (installer/host.ps1) に update.ps1 を走らせる。
// 同時に 2 本走らせない (連打で update.ps1 が並走して update.log / zip のロックで衝突した実害 2026-09-10)。
let inflight = null;
function runUpdate() {
  if (inflight) return inflight;
  inflight = (async () => {
    await chrome.action.setBadgeText({ text: '…' });
    const from = running();
    const r = await nativeCall('update');
    console.log('[bg] update', r);
    await chrome.storage.local.set({ lastUpdateResult: { at: new Date().toISOString(), ...r } });
    if (r.noHost) {
      notify('更新できません (native host 無し)', 'MSI で入れた端末だけボタン更新が使えます。zip 展開なら新しい zip を上書きして拡張カードの ↻ を押してください。\n' + (r.error || ''));
    } else if (!r.ok) {
      notify('更新に失敗', (r.error || r.output || '不明').split('\n').slice(-3).join('\n'));
    } else if (r.updated || (r.to && r.to !== from)) {
      notify(`v${from} → v${r.to} に更新`, '拡張をリロードします');
    } else {
      notify('ディスク上は最新', `v${r.to || from}`);
    }
    await checkLatest();
    // r.updated に頼らず、ディスクと動いている版を実測して決める
    await checkDiskVersion('after update');
    return r;
  })().finally(() => { inflight = null; });
  return inflight;
}

// ツールバーのアイコン: ディスクが新しければリロード → Release に新版があれば更新 → 無ければ claude.ai/code を開く
chrome.action.onClicked.addListener(async () => {
  if (await checkDiskVersion('action click')) return;
  if (await checkLatest()) { await runUpdate(); return; }
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/code*' });
  if (tabs.length) { await chrome.windows.update(tabs[0].windowId, { focused: true }); await chrome.tabs.update(tabs[0].id, { active: true }); }
  else await chrome.tabs.create({ url: 'https://claude.ai/code' });
});

// claude.ai のタブから診断・操作できる口 (externally_connectable)。
// Claude in Chrome の javascript_tool で chrome.runtime.sendMessage('<拡張ID>', { command }) を打つ用。
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  (async () => {
    const command = msg && msg.command;
    switch (command) {
      case 'get-version': {
        const { lastUpdateResult, lastSelfUpdate, latestVersion } = await chrome.storage.local.get(['lastUpdateResult', 'lastSelfUpdate', 'latestVersion']);
        return { ok: true, running: running(), onDisk: await diskVersion(), latestVersion, lastSelfUpdate, lastUpdateResult, inflight: !!inflight };
      }
      case 'check-update':  return { ok: true, latest: await checkLatest(), running: running() };
      case 'native-ping':   return await nativeCall('ping');
      case 'update':        return await runUpdate();
      case 'reload':        setTimeout(() => chrome.runtime.reload(), 300); return { ok: true };
      default:              return { ok: false, error: `unknown command: ${command}` };
    }
  })().then(sendResponse, (e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }));
  return true;
});

const arm = () => { chrome.alarms.create('self-update-check', { periodInMinutes: 10 }); };
chrome.runtime.onInstalled.addListener(() => { arm(); checkLatest(); });
chrome.runtime.onStartup.addListener(() => { arm(); checkDiskVersion('startup').then((r) => { if (!r) checkLatest(); }); });
chrome.alarms.onAlarm.addListener(async (a) => { if (a.name === 'self-update-check') { if (!(await checkDiskVersion('alarm'))) checkLatest(); } });
