<#
  claude-code-web-split-view の自動更新スクリプト (ippoan/gh-actions-live の update.ps1 の移植)。

  Chrome は Web Store 外の拡張の update_url を相手にしないので、自動更新は自前で 2 段:
    ① このスクリプトが GitHub Release を見て、新しければ zip を落として extension\ を上書きする
    ② 拡張が「ディスク上の manifest.json」と「動いている版」を比べ、違えば chrome.runtime.reload()

  ①が本ファイル。native messaging host (host.ps1) がツールバーのボタンから呼ぶ。
  定期的に勝手に上げたい場合は -Register でタスク スケジューラに登録する (既定では登録しない)。

  使い方:
    update.ps1               今すぐ 1 回チェックして更新
    update.ps1 -Register     タスク スケジューラに登録 (ログオン時 + 1 時間ごと、ユーザー権限)
    update.ps1 -Unregister   登録解除 (MSI の uninstall が呼ぶ)
#>
[CmdletBinding()]
param(
  [switch]$Register,
  [switch]$Unregister,
  [string]$Repo = 'ippoan/claude-code-web-split-view'
)
$ErrorActionPreference = 'Stop'
$TaskName = 'claude-code-web-split-view updater'
$Root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExtDir   = Join-Path $Root 'extension'
$LogFile  = Join-Path $Root 'update.log'
$Base     = "https://github.com/$Repo/releases/latest/download"
$ZipName  = 'claude-code-web-split-view-extension.zip'

# GitHub の Release 資産は application/octet-stream で返るため、5.1 の Invoke-WebRequest は
# .Content を string ではなく byte[] で返す ([xml] に流すと落ちる)。文字列に正規化する。
function Get-Text($uri, $timeout = 30) {
  $c = (Invoke-WebRequest -UseBasicParsing -Uri $uri -TimeoutSec $timeout).Content
  if ($c -is [byte[]]) { $c = [Text.Encoding]::UTF8.GetString($c) }
  return [string]$c
}

function Log($msg) {
  $line = "{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $msg
  # 並走した別インスタンスがログを掴んでいても本体の処理を止めない (ロックで例外→catch→Log→また例外、で落ちた実害 2026-09-10)
  try { Add-Content -Path $LogFile -Value $line -Encoding utf8 } catch { }
  Write-Host $line
}

# 同時に 2 本走らせない (ボタン連打・タスク スケジューラとの重なり)。後から来た方は何もせず 0 で抜ける
$script:Mutex = New-Object System.Threading.Mutex($false, 'Local\claude-code-web-split-view-updater')
if (-not $Mutex.WaitOne(0)) { Log "another updater is running; skip"; exit 0 }

if ($Register) {
  $ps = (Get-Command powershell.exe).Source
  $action  = New-ScheduledTaskAction -Execute $ps `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`""
  $logon   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $hourly  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) `
               -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable `
               -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($logon, $hourly) `
    -Settings $settings -RunLevel Limited -Force | Out-Null
  Log "registered scheduled task '$TaskName' (logon + hourly) -> $($MyInvocation.MyCommand.Path)"
  exit 0
}

if ($Unregister) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Log "unregistered scheduled task '$TaskName'"
  exit 0
}

# ---- 自分 (更新スクリプト群) の自己修復 ----
# update.ps1 / host.ps1 / host.bat は zip に入っていないので、Release の最新を取って差し替える。
# 実行中の自分を上書きしても PowerShell は読み込み済みなので問題ない。失敗しても本体の更新は続ける。
try {
  foreach ($name in @('update.ps1', 'host.ps1', 'host.bat')) {
    $dst = Join-Path $Root $name
    $new = Get-Text "$Base/$name" 60
    if (-not $new) { continue }
    $cur = if (Test-Path $dst) { [IO.File]::ReadAllText($dst) } else { '' }
    if ($new.TrimStart([char]0xFEFF) -ne $cur.TrimStart([char]0xFEFF)) {
      # .ps1 は BOM 付き UTF-8 で書く (5.1 が Shift_JIS で読んで壊れるのを防ぐ)
      if ($name -like '*.ps1') { [IO.File]::WriteAllText($dst, $new.TrimStart([char]0xFEFF), (New-Object Text.UTF8Encoding $true)) }
      else { [IO.File]::WriteAllText($dst, $new, [Text.Encoding]::ASCII) }
      Log "self-updated $name"
    }
  }
} catch { Log "self-update skipped: $($_.Exception.Message)" }

# ---- 更新チェック ----
try {
  $local = '0.0.0'
  $manifest = Join-Path $ExtDir 'manifest.json'
  if (Test-Path $manifest) { $local = (Get-Content $manifest -Raw | ConvertFrom-Json).version }

  [xml]$xml = (Get-Text "$Base/update.xml").TrimStart([char]0xFEFF)
  $remote = $xml.gupdate.app.updatecheck.version
  if (-not $remote) { throw "update.xml から version が読めない" }

  if ([version]$remote -le [version]$local) { Log "up to date ($local)"; exit 0 }
  Log "update available: $local -> $remote"

  $tmp = Join-Path $env:TEMP "claude-code-web-split-view-update-$remote"
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'extension.zip'
  Invoke-WebRequest -UseBasicParsing -Uri "$Base/$ZipName" -OutFile $zip -TimeoutSec 120
  $want = (Get-Text "$Base/$ZipName.sha256").Trim().ToLower()
  $have = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($want -ne $have) { throw "sha256 mismatch: want $want have $have" }

  $stage = Join-Path $tmp 'extension'
  Expand-Archive -Path $zip -DestinationPath $stage -Force
  $stagedVer = (Get-Content (Join-Path $stage 'manifest.json') -Raw | ConvertFrom-Json).version
  if ($stagedVer -ne $remote) { throw "zip の manifest version ($stagedVer) が update.xml ($remote) と違う" }

  # 上書き。消えたファイルも消したいので一度退避してから差し替える
  $bak = "$ExtDir.bak"
  if (Test-Path $bak) { Remove-Item $bak -Recurse -Force }
  if (Test-Path $ExtDir) { Move-Item $ExtDir $bak }
  try {
    Move-Item $stage $ExtDir
    if (Test-Path $bak) { Remove-Item $bak -Recurse -Force }
  } catch {
    if (-not (Test-Path $ExtDir) -and (Test-Path $bak)) { Move-Item $bak $ExtDir }
    throw
  }
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Log "updated to $remote (extension will reload itself)"
} catch {
  Log "ERROR: $($_.Exception.Message)"
  exit 1
}
