# Claude Code Web Split View

[claude.ai/code](https://claude.ai/code) (Claude Code on the Web) に、Claude Code desktop 版の
「セッション横並び」を足す Chrome 拡張。**PoC**。


## 操作

| 操作 | 何が起きるか |
|---|---|
| サイドバーのセッションを **Ctrl / ⌘ + クリック** | 右のペインに開く (desktop 版と同じ操作) |
| セッション行にホバーして右端の **⧉** | 同上 |
| ペイン上部の **⇄** | メインと入れ替える |
| ペイン上部の **↗** | メインで開く (ペインは閉じる) |
| ペイン上部の **×** | 閉じる |
| ペイン群の左端の縦バーをドラッグ | ペイン領域の幅を変える (15〜85%) |
| 縦バー上部の **⇤ / ⇥** | 親 (メイン) を畳んでペインに全幅を渡す / 戻す |
| 縦バー上部の **▤**、サイドバー上部 (「チャット / Code」の左) の **▤** | サイドバーを畳む (claude.ai 自身の「サイドバーを非表示」を押す。戻すのは左上に出る「サイドバーを表示」か同じ ▤) |

ペインで開いているセッションは、サイドバーの行に claude.ai 自身の選択色が付く (desktop 版の横並びと同じ)。

ペインのタイトルバー右側に状態が出る: **● 実行中 / ○ 待機中** (composer の停止ボタンの有無)、
**現在のモデル**、**モデル判定の段階** (判定前 / 題待ち / composer待ち / 切替中… / 規約どおり / 切替済 / 規約外 / 切替失敗)。
2 秒ごとにペイン側から更新される。

### 親子グループ (ippoan/claude-skills の task-split 命名規約)

| タイトル | 役 | 期待するモデル |
|---|---|---|
| `#p<issue> <題>` | 親 | Opus (Fable でも可) |
| `[S] #c<issue>-<n> <題>` / `[S] #p<issue>-c<子issue> <題>` | 子 | Sonnet |
| `[O] #c<issue>-<n> <題>` / タグ無しの子 | 子 | Opus (Fable でも可) |
| `[旧] #p<issue> <題>` | 旧親 | 触らない |

- **子を右に開く**: 親をメイン (またはペイン) で開いている間、サイドバーにあるその issue の子のうち
  ペインに出ていないものを自動で開く (起動時点で既にある子も、あとから spawn されて現れた子も)。
  × で閉じた子だけは、そのページを開いている間は開き直さない。リロードすれば再び開く
- **⊞ (親の行)**: 親と子をまとめて手で右に開く
- **モデルの強制**: セッション画面 (メインもペインも) を開いたとき、composer の「モデル: …」が
  上の期待と違えば、モデルメニューから切り替える (`[S]` なのに Opus → Sonnet、親なのに Sonnet → Opus)。
  規約に合わないタイトルは触らない。題や composer がまだ描画されていない回は何も決めず、15 秒おきに
  決着 (期待どおり / 切り替えた / 規約外) がつくまで見直す。決着後は手で変えたものを尊重する

ペインは何枚でも増やせる (1 枚あたり最小 360px、あふれたら横スクロール)。
構成は `chrome.storage.local` に残り、リロードで復元する。

## 仕組み (なぜこれで動くか)

claude.ai の CSP は `frame-ancestors 'self'` で、`x-frame-options` は無い (2026-09-10 実測)。
つまり **claude.ai 自身のページからなら同一オリジン iframe で `/code/session_…` を開ける**。
content script が `#root` を左に縮め、右に `position: fixed` のペイン群を置き、各ペインに
iframe を入れるだけ。iframe 内のセッション画面はサイドバー無しで描画される。

逆に `chrome-extension://` オリジン (popup ウィンドウ・`chrome.sidePanel`・options ページ) からは
frame-ancestors で弾かれるので、UI は拡張ページ側に持てない。**claude.ai をホストにする
content script 一択**で、[ippoan/gh-actions-live](https://github.com/ippoan/gh-actions-live)
(拡張ページが本体) とは作りが逆になる。

claude.ai の DOM class は難読化されているので、フックは `a[href^="/code/session_"]` のような
href ベースだけにしている。触るのは `#root` の幅と `<a>` の中身 (⧉) のみ。

## インストール

### 非管理端末 (既定、admin 不要)

1. [Releases](https://github.com/ippoan/claude-code-web-split-view/releases) から
   `claude-code-web-split-view-*-x64.msi` を落として実行 (ダブルクリックで可)。
   `%LOCALAPPDATA%\Programs\claude-code-web-split-view\extension` に配置され、
   native messaging host (ボタン更新の実体) が HKCU に登録される
2. `chrome://extensions` → 右上「デベロッパー モード」ON → 「パッケージ化されていない拡張機能を読み込む」→ 上のフォルダ
3. ID が `ibdmdncjfdpdmcakmdbdohieahjlkhoa` になっていることを確認。claude.ai/code を開き直す

MSI を使わない場合は `claude-code-web-split-view-extension.zip` を展開して読み込む
(この場合 native host が無いので、更新は新しい zip を同じフォルダに上書き展開して拡張カードの ↻)。

### 管理端末 (AD / Entra / Chrome Enterprise Core)

`msiexec /i claude-code-web-split-view-x.y.z-x64.msi ALLUSERS=1` (UAC 昇格) → Chrome 再起動。
HKLM の `ExtensionSettings` (force_installed + `update_url` = `releases/latest/download/update.xml`)
で入り、更新も Chrome が拾う。

## 更新

Chrome は Web Store 外の拡張の `update_url` を相手にしないので、gh-actions-live と同じ 2 段で自前に組む:

1. `installer/update.ps1` が Release の `update.xml` の版を見て、新しければ
   `claude-code-web-split-view-extension.zip` を落とし、sha256 を照合して `extension\` を差し替える
2. 拡張の service worker が 10 分ごとに「ディスク上の manifest.json の版」と「動いている版」を比べ、
   違えば `chrome.runtime.reload()`

①の起動は **ツールバーのアイコン** (新版があるとバッジに `UP` が出る。クリックで native host が
update.ps1 を実行。実行中はバッジが `…`) か、`update.ps1 -Register` でタスク スケジューラ
(ログオン時 + 1 時間ごと) に登録。結果は Windows の通知で出る (更新した / 最新だった / 失敗の理由)。
更新が無ければアイコンのクリックは claude.ai/code を開く (既に開いていれば前面に出す)。
連打しても update.ps1 は 1 本しか走らない (拡張側は in-flight guard、ps1 側は named mutex)。

### 診断 (claude.ai のタブから)

拡張は `externally_connectable` で `https://claude.ai/*` からのメッセージを受ける。
Claude in Chrome の javascript_tool で claude.ai のタブから打てる:

```js
chrome.runtime.sendMessage('ibdmdncjfdpdmcakmdbdohieahjlkhoa', { command: 'get-version' }, r => console.log(r));
// running / onDisk / latestVersion / lastUpdateResult (native host の直近の応答) が返る
// command: check-update / native-ping / update / reload / get-log / clear-log も同じ経路
```

`get-log` は content script の判定ログ (直近 300 件、`chrome.storage.local` の `ccw:log`)。
モデル強制の各分岐 (`enforce:no-title` / `no-composer` / `out-of-convention` / `ok` / `switched` /
`switch-failed` / `menu-item-missing`)、ペインの起動 (`pane:init`)、子の自動展開 (`child:auto-open`) が
frame (top / pane)・path・題つきで残る。「切り替わらない」ときはまずこれを読む。

ログは `%LOCALAPPDATA%\Programs\claude-code-web-split-view\update.log`。

## リリースサイクル

gh-actions-live と同じ。`main` への push で patch を自動採番して `vX.Y.Z` の Release を作る。
PR (non-draft) は CI が緑になると `dev-<run_number>` の prerelease を出し、org 標準の
auto-merge が squash merge する。tag を手で打つ経路は無い。
`.crx` の署名鍵は repo secret `CRX_PRIVATE_KEY` (manifest の `key` と同じ鍵)。

## リポジトリ構成

```
extension/            MV3 拡張本体 (content.js = 分割画面、background.js = 自動更新)
installer/main.wxs    MSI (WiX v5、perUserOrMachine)
installer/update.ps1  更新スクリプト (native host / 手動 / 任意でタスク登録)
installer/host.ps1    native messaging host (アイコンクリック更新の実体)
```

## 既知の制約

- ペイン 1 枚ごとに claude.ai への接続 (WebSocket / SSE) とメモリが増える
- ペインのタイトルは開いた時点のサイドバーの文字列。ペイン内で別セッションへ移ると
  サイドバーから引き直す (見つからなければパス表示)
- iframe 内にサイドバーが出ない挙動は claude.ai 側のもので、変わったら CSS で隠す必要がある
- desktop 版の「ドラッグで横並び」ジェスチャは未実装 (Ctrl/⌘+クリックと ⧉ のみ)
- native host 経由のボタン更新 (ツールバーのアイコン → update.ps1) は Windows 実機で未確認
  (MSI の配置と拡張の読み込み・分割画面そのものは v0.0.1 で確認済み。下記)

## 実機確認 (v0.0.1、Windows 11 + Chrome、2026-09-10)

- MSI (perUser) を実行 → `%LOCALAPPDATA%\Programs\claude-code-web-split-view\extension` を
  「パッケージ化されていない拡張機能を読み込む」で読み込み、ID が `ibdmdncjfdpdmcakmdbdohieahjlkhoa` で一致
- claude.ai/code を開くとサイドバーの全セッション行に ⧉ が付く
- セッション行を Ctrl+クリック → 右にペインが開き、`#root` が 1920px → 960px に縮む。
  iframe 内は content script が入り (`html[data-ccw-pane]`)、composer 付きでサイドバー無し
- ⧉ で 2 枚目 → 2 ペインが等幅で並ぶ (各 477px)。ストリーミング中のセッションもそのまま流れる
- リロード → 2 ペインとも復元。× で閉じると `#root` が 1920px に戻る
- 未署名 MSI なので初回実行時に SmartScreen (「Windows によって PC が保護されました」) が出る。
  「詳細情報」→「実行」で通る (gh-actions-live の MSI と同じ)
