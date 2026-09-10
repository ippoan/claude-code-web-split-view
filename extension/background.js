// service worker: 自動更新まわりだけ (分割画面そのものは content.js)。
// 仕組みは ippoan/gh-actions-live と同じ 2 段:
//   ① installer/update.ps1 が GitHub Release の update.xml を見て extension\ を差し替える
//      (native messaging host 経由でボタン/コマンドから、または update.ps1 -Register でタスク登録)
//   ② ここが「ディスク上の manifest.json の版」と「動いている版」を 10 分ごとに比べ、
//      違えば chrome.runtime.reload() する
const REPO = 'ippoan/claude-code-web-split-view';
const NATIVE_HOST = 'jp.ippoan.claude_code_web_split_view';
const UPDATE_XML = `https://github.com/${REPO}/releases/latest/download/update.xml`;

const cmpVer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };

// ②: ディスク上の版が動いている版と違えば自分をリロード (update.ps1 が差し替えた後)
async function checkDiskVersion() {
  try {
    const r = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' });
    const onDisk = (await r.json()).version;
    const running = chrome.runtime.getManifest().version;
    if (!onDisk || onDisk === running) return false;
    console.log('[bg] on-disk version', onDisk, '!= running', running, '-> reload');
    await chrome.storage.local.set({ lastSelfUpdate: `${running} -> ${onDisk}` });
    setTimeout(() => chrome.runtime.reload(), 300);
    return true;
  } catch (e) { console.warn('[bg] checkDiskVersion', e); return false; }
}

// Release に新版があるか (badge に UP を出すだけ。取りに行くのは native host)
async function checkLatest() {
  try {
    const r = await fetch(UPDATE_XML, { cache: 'no-store' });
    if (!r.ok) return null;
    const m = (await r.text()).match(/version=['"]([0-9.]+)['"]/);
    const latest = m && m[1];
    const running = chrome.runtime.getManifest().version;
    const newer = !!latest && cmpVer(latest, running) > 0;
    await chrome.action.setBadgeText({ text: newer ? 'UP' : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#da7756' });
    await chrome.storage.local.set({ latestVersion: latest || null });
    return newer ? latest : null;
  } catch (e) { console.warn('[bg] checkLatest', e); return null; }
}

// ①をボタンから起動する: native host (installer/host.ps1) に update.ps1 を走らせる。
// MSI で入れていない (zip 展開) 端末には host が無く reject する → その場合は何もしない
async function runUpdate() {
  try {
    const r = await chrome.runtime.sendNativeMessage(NATIVE_HOST, { cmd: 'update' });
    console.log('[bg] update', r);
    if (r && r.ok && r.updated) { await chrome.storage.local.set({ lastSelfUpdate: `${r.from} -> ${r.to}` }); setTimeout(() => chrome.runtime.reload(), 300); }
    return r;
  } catch (e) { console.warn('[bg] native host 無し (MSI 未導入?)', e?.message || e); return { ok: false, noHost: true }; }
}

// ツールバーのアイコン: 新版があれば更新、無ければ claude.ai/code を開く (無ければ前面に出す)
chrome.action.onClicked.addListener(async () => {
  if (await checkLatest()) { const r = await runUpdate(); if (r && r.ok) return; }
  const tabs = await chrome.tabs.query({ url: 'https://claude.ai/code*' });
  if (tabs.length) { await chrome.windows.update(tabs[0].windowId, { focused: true }); await chrome.tabs.update(tabs[0].id, { active: true }); }
  else await chrome.tabs.create({ url: 'https://claude.ai/code' });
});

const arm = () => { chrome.alarms.create('self-update-check', { periodInMinutes: 10 }); };
chrome.runtime.onInstalled.addListener(() => { arm(); checkLatest(); });
chrome.runtime.onStartup.addListener(() => { arm(); checkLatest(); });
chrome.alarms.onAlarm.addListener(async (a) => { if (a.name === 'self-update-check') { if (!(await checkDiskVersion())) checkLatest(); } });
