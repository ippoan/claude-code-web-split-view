# CLAUDE.md — ippoan/claude-code-web-split-view

claude.ai/code に分割画面を足す Chrome 拡張 (MV3)。利用者向けは [README.md](./README.md)。

## repo-policy

- branch: `claude/<topic>` または `<issue-number>-<type>-<short-desc>`。main 直 push 禁止、PR 経由。
- PR / commit に `Closes` / `Fixes` を使わない。**`Refs #N`**。
- main への merge = Release (自動採番)。PR が緑になれば新版が出るので、壊れた版を出さないこと。

## 設計の前提 (変えるなら README も直す)

- UI は **claude.ai 上の content script** にしか置けない (CSP `frame-ancestors 'self'`)。
  拡張ページ / sidePanel に iframe を置く案は最初から不成立。
- claude.ai の DOM は href ベース (`a[href^="/code/session_"]`) でしか触らない。class 名に依存しない。
- 自動更新は ippoan/gh-actions-live の移植。installer/ と background.js の更新まわりを変えるときは
  あちらと突き合わせる (共通化候補)。

## テスト

拡張を読み込まなくても、`extension/content.js` を claude.ai/code のタブに javascript_tool で
流し込めば動く (chrome.storage が無ければ localStorage に落ちる)。`window.ccwSplit` が試験口。
CI は構文・manifest・拡張 ID の整合・ps1 の BOM を見る。
