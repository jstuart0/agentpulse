param(
  [string]$Ref = "main",
  [string]$Repo = "https://github.com/jstuart0/agentpulse.git",
  [string]$Dir = "$HOME\.agentpulse\app",
  [string]$DataDir = "$HOME\.agentpulse\data",
  [int]$Port = 3000,
  [string]$HostName = "0.0.0.0",
  [string]$PublicUrl = "",
  [bool]$DisableAuth = $true,
  [string]$ApiKey = "",
  [switch]$SkipHooks,
  [switch]$SkipSupervisor,
  # Phase 5: dot-source with -FunctionsOnly to load the hook-command
  # generators (New-ApHookCommand / New-ApCodexHooksFile / New-ApHookAuthHeaderFile)
  # without running the installer's main flow — used by
  # scripts/test-install-local.ps1 and scripts/hook-command-parity.test.ts.
  [switch]$FunctionsOnly
)

$ErrorActionPreference = "Stop"

if (-not $PublicUrl) {
  $PublicUrl = "http://localhost:$Port"
}

$AgentPulseDir = Join-Path $HOME ".agentpulse"
$LogDir = Join-Path $AgentPulseDir "logs"
$SupervisorConfigPath = Join-Path $AgentPulseDir "supervisor.json"
$EnvFile = Join-Path $Dir ".env.local"
$ServerTask = "AgentPulseLocal"
$SupervisorTask = "AgentPulseSupervisor"

function Write-Step($msg) {
  Write-Host "  $msg"
}

function Ensure-Command($name) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  if (-not $cmd) {
    throw "$name is required for Windows installation."
  }
  return $cmd.Source
}

function Ensure-Bun {
  $bun = Get-Command bun -ErrorAction SilentlyContinue
  if ($bun) {
    Write-Step "✓ Bun: $($bun.Source)"
    return $bun.Source
  }

  $bunPath = Join-Path $HOME ".bun\bin\bun.exe"
  if (Test-Path $bunPath) {
    $env:Path = "$(Split-Path $bunPath);$env:Path"
    Write-Step "✓ Bun: $bunPath"
    return $bunPath
  }

  Write-Step "Installing Bun..."
  Invoke-RestMethod https://bun.sh/install.ps1 | Invoke-Expression
  $bunPath = Join-Path $HOME ".bun\bin\bun.exe"
  $env:Path = "$(Split-Path $bunPath);$env:Path"
  Write-Step "✓ Bun: $bunPath"
  return $bunPath
}

function Ensure-Dir($path) {
  if (-not (Test-Path $path)) {
    New-Item -ItemType Directory -Force -Path $path | Out-Null
  }
}

function Invoke-JsonRequest {
  param(
    [string]$Method,
    [string]$Url,
    [object]$Body = $null,
    [hashtable]$Headers = @{}
  )
  $params = @{
    Method = $Method
    Uri = $Url
    Headers = $Headers
  }
  if ($null -ne $Body) {
    $params["ContentType"] = "application/json"
    $params["Body"] = ($Body | ConvertTo-Json -Depth 10 -Compress)
  }
  Invoke-RestMethod @params
}

function Set-JsonFile {
  param(
    [string]$Path,
    [object]$Data
  )
  Ensure-Dir ([System.IO.Path]::GetDirectoryName($Path))
  $Data | ConvertTo-Json -Depth 20 | Set-Content -Path $Path -Encoding UTF8
}

function Merge-Hashtable {
  param(
    [hashtable]$Base,
    [hashtable]$Overlay
  )
  foreach ($key in $Overlay.Keys) {
    if ($Base[$key] -is [hashtable] -and $Overlay[$key] -is [hashtable]) {
      Merge-Hashtable -Base $Base[$key] -Overlay $Overlay[$key]
    } else {
      $Base[$key] = $Overlay[$key]
    }
  }
}

# >>> agentpulse-hook-cmd
# D13: PowerShell transcription of buildBashHookCommand/buildCodexHooksFile
# (src/shared/hook-command.ts), verified structurally by
# scripts/hook-command-parity.test.ts (static string comparison — pwsh isn't
# available in the primary dev/CI environment; scripts/test-install-local.ps1
# is the real execution coverage, run by the "Windows Installer Validation"
# CI job). Do not hand-edit one copy without the other.
function New-ApHookCommand {
  param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][bool]$Direct,
    [Parameter(Mandatory = $true)][string]$AgentType,
    [Parameter(Mandatory = $true)][string]$EventName
  )
  if ($BaseUrl -notmatch '^https?://([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?$') {
    throw "invalid AgentPulse base URL for a hook command: $BaseUrl"
  }
  $url = "$BaseUrl/api/v1/hooks?event=$EventName"
  $headerFileLine = if ($Direct) { "`$f = Join-Path `$HOME '.agentpulse\hook-auth-header'`n" } else { "`$f = `$null`n" }
  $authArg = "(if (`$f -and (Test-Path `$f -ErrorAction SilentlyContinue) -and (Get-Item `$f -ErrorAction SilentlyContinue).Length -gt 0) { @('-H',`"@`$f`") } else { @() })"
  # F248 (codex r2 D38): marker extraction/write now runs INSIDE the
  # Start-Job block, reading from the temp file there — D13 requires the
  # synchronous (parent-process) path to be stdin-drain + temp-file-write
  # only. Reads the temp file itself since Start-Job's script block runs
  # in an isolated runspace with no access to parent variables beyond what
  # -ArgumentList passes in.
  $markerLine = ""
  if ($AgentType -eq "codex_cli") {
    $markerLine = "`$jobRaw = [IO.File]::ReadAllText(`$t); `$sid = [regex]::Match(`$jobRaw, '`"session_id`"\s*:\s*`"([A-Za-z0-9-]{1,128})`"').Groups[1].Value; if (`$sid) { `$md = Join-Path `$HOME '.agentpulse\codex-native'; New-Item -ItemType Directory -Force `$md -ErrorAction SilentlyContinue | Out-Null; New-Item -ItemType File -Force (Join-Path `$md `$sid) -ErrorAction SilentlyContinue | Out-Null }`n  "
  }
  return (
    "`$ErrorActionPreference = 'SilentlyContinue'`n" +
    "`$d = Join-Path `$env:TEMP 'agentpulse-hooks'`n" +
    "New-Item -ItemType Directory -Force `$d | Out-Null`n" +
    "`$t = Join-Path `$d ([guid]::NewGuid().ToString())`n" +
    "`$raw = [Console]::In.ReadToEnd()`n" +
    "[IO.File]::WriteAllText(`$t, `$raw)`n" +
    $headerFileLine +
    "Start-Job -ScriptBlock {`n" +
    "  param(`$t, `$f, `$url, `$agent)`n" +
    "  " + $markerLine +
    "`$headerArgs = $authArg`n" +
    "  `$curlArgs = @('-sS','--max-time','2','-o','NUL','-X','POST',`$url,'-H','Content-Type: application/json','-H',`"X-Agent-Type: `$agent`") + `$headerArgs + @('--data-binary',`"@`$t`")`n" +
    "  Start-Process -FilePath curl.exe -WindowStyle Hidden -ArgumentList `$curlArgs -Wait`n" +
    "  Remove-Item -Force `$t -ErrorAction SilentlyContinue`n" +
    "} -ArgumentList `$t, `$f, '$url', '$AgentType' | Out-Null`n" +
    "Get-ChildItem `$d -ErrorAction SilentlyContinue | Where-Object { `$_.LastWriteTime -lt (Get-Date).AddMinutes(-5) } | Remove-Item -Force -ErrorAction SilentlyContinue`n" +
    "exit 0`n"
  )
}

function New-ApCodexHooksFile {
  param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][bool]$Direct
  )
  $codexEvents = @("SessionStart","SessionEnd","PreToolUse","PostToolUse","UserPromptSubmit","Stop","Interrupt","SubagentStart","SubagentStop","PermissionRequest","PreCompact","PostCompact")
  $hooks = [ordered]@{}
  foreach ($event in $codexEvents) {
    $cmd = New-ApHookCommand -BaseUrl $BaseUrl -Direct $Direct -AgentType "codex_cli" -EventName $event
    $hooks[$event] = @(
      [ordered]@{
        hooks = @(
          [ordered]@{ type = "command"; command = $cmd; async = $false; timeout = 1 }
        )
      }
    )
  }
  $obj = [ordered]@{ hooks = $hooks }
  return ($obj | ConvertTo-Json -Depth 20) + "`n"
}

# D13: the POSIX `sh` equivalent of New-ApHookCommand, transcribed natively
# in PowerShell (never shells out to bash) — Copilot's agentpulse.json
# carries both a `bash` and a `powershell` handler per event (D13), and this
# builds the former. Scoped to Copilot only: it never needs the Codex
# native-coverage marker snippet, so there's no marker branch here (compare
# buildBashHookCommand/ap_hook_cmd's `agent -eq codex_cli` check).
function New-ApCopilotBashHookCommand {
  param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][bool]$Direct,
    [Parameter(Mandatory = $true)][string]$EventName
  )
  $curl = "curl -sS --max-time 2 -o /dev/null -X POST '$BaseUrl/api/v1/hooks?event=$EventName' -H 'Content-Type: application/json' -H 'X-Agent-Type: copilot_cli'"
  $withHeader = "$curl" + " -H `"@`$f`" --data-binary `"@`$t`""
  $withoutHeader = "$curl --data-binary `"@`$t`""
  $body = if ($Direct) {
    "f=`"`$HOME/.agentpulse/hook-auth-header`"; if [ -s `"`$f`" ]; then $withHeader; else $withoutHeader; fi; rm -f `"`$t`""
  } else {
    "$withoutHeader; rm -f `"`$t`""
  }
  $mktempPrefix = "t=`$(mktemp `"`${TMPDIR:-/tmp}/agentpulse-hook.XXXXXX`" 2>/dev/null) || exit 0; cat > `"`$t`"; "
  return "$mktempPrefix( $body ) </dev/null >/dev/null 2>&1 & exit 0"
}

function New-ApCopilotHooksFile {
  param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][bool]$Direct
  )
  $copilotEvents = @("sessionStart","sessionEnd","userPromptSubmitted","postToolUse","postToolUseFailure","agentStop","subagentStart","subagentStop","preCompact","errorOccurred")
  $hooks = [ordered]@{}
  foreach ($event in $copilotEvents) {
    $bash = New-ApCopilotBashHookCommand -BaseUrl $BaseUrl -Direct $Direct -EventName $event
    $ps = New-ApHookCommand -BaseUrl $BaseUrl -Direct $Direct -AgentType "copilot_cli" -EventName $event
    $hooks[$event] = @(
      [ordered]@{ type = "command"; bash = $bash; powershell = $ps; timeoutSec = 5 }
    )
  }
  $obj = [ordered]@{ version = 1; hooks = $hooks }
  return ($obj | ConvertTo-Json -Depth 20) + "`n"
}

# F233 (xander, Medium): true for a symlink OR a junction/mount-point
# reparse point at $Path — `.LinkType` alone misses some reparse-point
# kinds (e.g. a mount point has no LinkType but does carry the
# ReparsePoint attribute), so both are checked. A missing path (the common
# case — nothing to refuse) returns $false, not an error.
function Test-ApReparsePoint {
  param([Parameter(Mandatory = $true)][string]$Path)
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if (-not $item) { return $false }
  if ($item.LinkType) { return $true }
  return [bool]($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

# F242 (xander, re-verify): true when $Path already has more than one hard
# link — a second directory entry pointing at the same NTFS data stream,
# which `fsutil hardlink list` enumerates without needing elevation (it's
# a read-only query). Best-effort: `fsutil` can be missing, blocked by
# policy, or fail on a non-NTFS volume — any of that fails OPEN (returns
# $false) rather than blocking a legitimate install, since the caller's
# reparse-point check plus the temp-file+Move-Item replace pattern (which
# never writes into the target's existing data stream in place) are
# already the primary defense. This is the one part of F242 not verified
# against a real Windows machine in this environment — Windows CI
# (scripts/test-install-local.ps1) is the real check; flag to xander if it
# proves unreliable there.
function Test-ApMultipleHardLinks {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  try {
    $output = & fsutil hardlink list $Path 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $output) { return $false }
    $count = @($output | Where-Object { $_.Trim().Length -gt 0 }).Count
    return $count -gt 1
  } catch {
    return $false
  }
}

# F232 (xander, Medium): writes $Content to $Path via a same-directory temp
# file + atomic Move-Item, refusing a reparse point (symlink/junction) at
# $Path or at its parent directory — never a plain Set-Content/Copy-Item,
# both of which write through a reparse point at the destination. Used for
# both a Codex/Copilot hooks.json write and its timestamped backup (same
# primitive, different path) — mirrors ap_write_no_follow in the bash
# installers (scripts/setup-hooks.sh et al). F242: also refuses a
# multiply-hard-linked target — see Test-ApMultipleHardLinks above.
function Write-ApFileNoFollow {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )
  if (Test-ApReparsePoint -Path $Path) {
    throw "refusing to write through a reparse point: $Path"
  }
  if (Test-ApMultipleHardLinks -Path $Path) {
    throw "refusing to write through a multiply-linked file: $Path"
  }
  $dir = Split-Path -Parent $Path
  if (Test-ApReparsePoint -Path $dir) {
    throw "refusing to write into a reparse-point directory: $dir"
  }
  $tmp = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  Set-Content -NoNewline -Path $tmp -Value $Content -Encoding UTF8
  Move-Item -Force -Path $tmp -Destination $Path
}

# D13: writes ~/.agentpulse/hook-auth-header with a single-ACE ACL for the
# current user (Windows equivalent of `umask 077`).
#
# F208: narrow the parent .agentpulse directory's ACL to the current user
# *before* creating the file inside it, so a freshly-created file inherits
# a private ACL from the instant it exists. Set-Content-then-icacls-the-
# file alone (the prior shape) left a window where a newly (over)written
# file briefly held the directory's broader, inherited ACL before icacls
# narrowed it. The file-level icacls call stays too, so re-running this
# against a pre-existing file (from before this fix, or one an operator
# copied in some other way) still ends up narrowed, not just new ones.
#
# F233 (xander, Medium): neither the directory nor the file had a
# reparse-point guard — a junction at .agentpulse, or a symlink at
# hook-auth-header itself, could redirect the API key to an
# attacker-chosen location. Checked before either write, same as the bash
# installers' `[ -L "$AP_AUTH_HEADER_FILE" ]` guard. F242: also refuses a
# multiply-hard-linked target file — see Test-ApMultipleHardLinks above.
function New-ApHookAuthHeaderFile {
  param([Parameter(Mandatory = $true)][string]$ApiKey)
  $d = Join-Path $HOME ".agentpulse"
  if (Test-ApReparsePoint -Path $d) {
    throw "refusing to write through a reparse point: $d"
  }
  New-Item -ItemType Directory -Force -Path $d | Out-Null
  icacls $d /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
  $f = Join-Path $d "hook-auth-header"
  if (Test-ApMultipleHardLinks -Path $f) {
    throw "refusing to write through a multiply-linked file: $f"
  }
  if (Test-ApReparsePoint -Path $f) {
    throw "refusing to write through a reparse point: $f"
  }
  Set-Content -NoNewline -Path $f -Value "Authorization: Bearer $ApiKey`n" -Encoding UTF8
  icacls $f /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
}
# <<< agentpulse-hook-cmd

function Configure-Hooks {
  Write-Step "Configuring Claude Code + Codex hooks..."

  # AGEN-49/H2 (xander): Claude Code's native HTTP hook expands
  # $env:AGENTPULSE_API_KEY from ITS OWN process environment, not the shell
  # that launched Claude Code — a GUI, IDE, or stale-terminal launch never
  # has HKCU\Environment's value in its process env either (that's set for
  # NEW processes launched after SetEnvironmentVariable("User", ...), not
  # ones already running), so the env-var form 401s silently there. This
  # installer has no project-scope option (it always targets $HOME), so a
  # supplied key gets the literal, more-reliable form — acceptable because
  # settings.json gets a single-ACE, user-only ACL below (icacls), never
  # broadly readable. No key at all keeps the env-var/allowedEnvVars form.
  $hookHeadersClaude = @{ "X-Agent-Type" = "claude_code" }
  if ($ApiKey) {
    $hookHeadersClaude["Authorization"] = "Bearer $ApiKey"
  }

  $claudeDir = Join-Path $HOME ".claude"
  $claudeSettings = Join-Path $claudeDir "settings.json"
  # F249 ordering: refuse a reparse point at the parent BEFORE Ensure-Dir
  # even runs (a directory create against an already-reparse-point path is
  # a silent no-op success), then refuse one at the file itself before any
  # read/write. settings.json holds other user settings we must preserve,
  # so this can't just delegate to New-ApHookAuthHeaderFile (which
  # overwrites the whole file).
  if (Test-ApReparsePoint -Path $claudeDir) {
    throw "refusing to write through a reparse point: $claudeDir"
  }
  Ensure-Dir $claudeDir
  if (Test-ApReparsePoint -Path $claudeSettings) {
    throw "refusing to write through a reparse point: $claudeSettings"
  }
  $claudeData = @{}
  if (Test-Path $claudeSettings) {
    $existing = Get-Content $claudeSettings -Raw | ConvertFrom-Json -AsHashtable
    if ($existing) { $claudeData = $existing }
  }
  if (-not $claudeData.ContainsKey("hooks")) {
    $claudeData["hooks"] = @{}
  }
  foreach ($eventName in @("SessionStart","SessionEnd","PreToolUse","PostToolUse","Stop","SubagentStart","SubagentStop","TaskCreated","TaskCompleted","UserPromptSubmit","PermissionRequest","PermissionDenied","Notification","PreCompact","PostCompact","PostToolUseFailure")) {
    $hook = @{
      matcher = ""
      hooks = @(@{
        type = "http"
        url = "$PublicUrl/api/v1/hooks"
        async = $true
        headers = $hookHeadersClaude
      })
    }
    if (-not $ApiKey) {
      $hook.hooks[0]["allowedEnvVars"] = @("AGENTPULSE_API_KEY")
    }
    $claudeData["hooks"][$eventName] = @($hook)
  }
  Set-JsonFile -Path $claudeSettings -Data $claudeData
  if ($ApiKey) {
    # H2: a literal key is embedded above, so settings.json is narrowed to
    # a single ACE for the current user — never inherited/broadly readable.
    icacls $claudeSettings /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
  }

  # D12 (r6, Phase 0 fact 5): Codex 0.145 loads hooks only from
  # $CODEX_HOME/hooks.json — a project-level .codex/hooks.json is never read.
  $codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
  Ensure-Dir $codexDir
  $codexHooksFile = Join-Path $codexDir "hooks.json"

  if ($ApiKey) {
    New-ApHookAuthHeaderFile -ApiKey $ApiKey
  }

  $newCodexHooksJson = New-ApCodexHooksFile -BaseUrl $PublicUrl -Direct $true
  $unchanged = $false
  if (Test-Path $codexHooksFile) {
    $existingCodexHooksJson = Get-Content $codexHooksFile -Raw
    if ($existingCodexHooksJson -eq $newCodexHooksJson) {
      $unchanged = $true
    }
  }
  if ($unchanged) {
    Write-Step "Codex hooks unchanged — no re-trust needed"
  } else {
    if (Test-Path $codexHooksFile) {
      $codexBackupFile = "$codexHooksFile.agentpulse-bak.$(Get-Date -AsUTC -Format 'yyyyMMddTHHmmssZ')"
      Write-ApFileNoFollow -Path $codexBackupFile -Content $existingCodexHooksJson
      Write-Step "Backed up existing Codex hooks to $codexBackupFile"
    }
    Write-ApFileNoFollow -Path $codexHooksFile -Content $newCodexHooksJson
    Write-Step "Codex CLI hooks configured"
    Write-Step "Open Codex and run /hooks, then trust the AgentPulse hooks — Codex silently skips untrusted hooks."
    Write-Step "Re-trust after changing the AgentPulse URL or port."
  }
  # D12: codex_hooks is a deprecated (but still-working) legacy alias for
  # [features].hooks — left alone if present, never newly written.

  # D8: only written when copilot is detected — never create config for a
  # tool that isn't installed.
  $copilotDetected = (Get-Command copilot -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $HOME ".copilot"))
  if ($copilotDetected) {
    $copilotDir = Join-Path $HOME ".copilot\hooks"
    Ensure-Dir $copilotDir
    $copilotHooksFile = Join-Path $copilotDir "agentpulse.json"

    $newCopilotHooksJson = New-ApCopilotHooksFile -BaseUrl $PublicUrl -Direct $true
    $copilotUnchanged = $false
    if (Test-Path $copilotHooksFile) {
      $existingCopilotHooksJson = Get-Content $copilotHooksFile -Raw
      if ($existingCopilotHooksJson -eq $newCopilotHooksJson) {
        $copilotUnchanged = $true
      }
    }
    if ($copilotUnchanged) {
      Write-Step "Copilot hooks unchanged"
    } else {
      if (Test-Path $copilotHooksFile) {
        $copilotBackupFile = "$copilotHooksFile.agentpulse-bak.$(Get-Date -AsUTC -Format 'yyyyMMddTHHmmssZ')"
        Write-ApFileNoFollow -Path $copilotBackupFile -Content $existingCopilotHooksJson
        Write-Step "Backed up existing Copilot hooks to $copilotBackupFile"
      }
      Write-ApFileNoFollow -Path $copilotHooksFile -Content $newCopilotHooksJson
      Write-Step "Copilot CLI hooks configured"
    }
  }

  # D37/F243 (xander re-verify — "check whether install-local.ps1 persists
  # the key in a user env var or profile, and apply the same principle"):
  # checked. This writes to HKCU\Environment (SetEnvironmentVariable's
  # "User" target), a per-user registry hive — not a plaintext rc FILE.
  # Windows already isolates HKCU\Environment to the owning user's SID via
  # registry ACLs; another local account can't read it the way a
  # world-readable 0644 ~/.zshrc exposes a POSIX key to any local user.
  # That's the same owner-only guarantee D37 moved the POSIX key to
  # ~/.agentpulse/env (0600) to achieve, just via the platform-native
  # mechanism instead — no change needed here.
  if ($ApiKey) {
    [Environment]::SetEnvironmentVariable("AGENTPULSE_API_KEY", $ApiKey, "User")
    [Environment]::SetEnvironmentVariable("AGENTPULSE_URL", $PublicUrl, "User")
  }

  Write-Step "✓ Hooks configured"
}

function New-TaskActionForPowerShell {
  param([string]$ScriptPath)
  New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""
}

function Register-OrUpdateTask {
  param(
    [string]$TaskName,
    [string]$ScriptPath,
    [string]$Description
  )
  $action = New-TaskActionForPowerShell -ScriptPath $ScriptPath
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description $Description -Force | Out-Null
}

function Start-TaskNow {
  param([string]$ScriptPath)
  Start-Process -WindowStyle Hidden -FilePath "powershell.exe" -ArgumentList @("-NoProfile","-ExecutionPolicy","Bypass","-File",$ScriptPath) | Out-Null
}

# Phase 5: every function above is now defined. Dot-sourcing with
# -FunctionsOnly stops here, before the main install flow runs, so tests can
# load New-ApHookCommand / New-ApCodexHooksFile / New-ApHookAuthHeaderFile
# (and the rest) without executing an install.
if ($FunctionsOnly) {
  return
}

Write-Host ""
Write-Host "  AgentPulse Local Install"
Write-Host "  ────────────────────────"
Write-Host "  Repo:       $Repo ($Ref)"
Write-Host "  Install:    $Dir"
Write-Host "  Data:       $DataDir"
Write-Host "  URL:        $PublicUrl"
Write-Host "  Hooks:      $(-not $SkipHooks)"
Write-Host "  Supervisor: $(-not $SkipSupervisor)"
Write-Host ""

$git = Ensure-Command git
$bun = Ensure-Bun
Ensure-Dir ([System.IO.Path]::GetDirectoryName($Dir))
Ensure-Dir $DataDir
Ensure-Dir $AgentPulseDir
Ensure-Dir $LogDir

if (Test-Path (Join-Path $Dir ".git")) {
  Write-Step "Updating existing checkout..."
  & $git -C $Dir fetch --tags origin
  & $git -C $Dir checkout $Ref
  try { & $git -C $Dir pull --ff-only origin $Ref } catch {}
} else {
  Write-Step "Cloning repository..."
  if (Test-Path $Dir) { Remove-Item -Recurse -Force $Dir }
  & $git clone --branch $Ref --single-branch $Repo $Dir
}

Set-Location $Dir

Write-Step "Installing dependencies..."
& $bun install

Write-Step "Building application..."
& $bun run build

@"
PORT=$Port
HOST=$HostName
PUBLIC_URL=$PublicUrl
DISABLE_AUTH=$DisableAuth
AGENTPULSE_INITIAL_API_KEY=$ApiKey
DATA_DIR=$DataDir
SQLITE_PATH=$DataDir\agentpulse.db
NODE_ENV=production
"@ | Set-Content -Path $EnvFile -Encoding UTF8
Write-Step "✓ Wrote $EnvFile"

$serverScript = Join-Path $AgentPulseDir "start-agentpulse-server.ps1"
$supervisorScript = Join-Path $AgentPulseDir "start-agentpulse-supervisor.ps1"
$serverLog = Join-Path $LogDir "agentpulse.out.log"
$serverErr = Join-Path $LogDir "agentpulse.err.log"
$supervisorLog = Join-Path $LogDir "supervisor.out.log"
$supervisorErr = Join-Path $LogDir "supervisor.err.log"

@"
`$env:PORT = "$Port"
`$env:HOST = "$HostName"
`$env:PUBLIC_URL = "$PublicUrl"
`$env:DISABLE_AUTH = "$DisableAuth"
`$env:AGENTPULSE_INITIAL_API_KEY = "$ApiKey"
`$env:DATA_DIR = "$DataDir"
`$env:SQLITE_PATH = "$DataDir\agentpulse.db"
`$env:NODE_ENV = "production"
Set-Location "$Dir"
& "$bun" run start *>> "$serverLog" 2>> "$serverErr"
"@ | Set-Content -Path $serverScript -Encoding UTF8

Register-OrUpdateTask -TaskName $ServerTask -ScriptPath $serverScript -Description "AgentPulse local server"
Start-TaskNow -ScriptPath $serverScript
Write-Step "✓ Scheduled local server"

Write-Host ""
Write-Step "Waiting for AgentPulse to start..."
$healthy = $false
for ($i = 0; $i -lt 30; $i++) {
  try {
    Invoke-RestMethod "$PublicUrl/api/v1/health" | Out-Null
    $healthy = $true
    break
  } catch {
    Start-Sleep -Seconds 1
  }
}

if (-not $healthy) {
  throw "AgentPulse was installed but the health check did not pass in time."
}

Write-Step "✓ AgentPulse is running at $PublicUrl"
Write-Host ""

$supervisorEnrollmentToken = ""
if (-not $SkipSupervisor) {
  if (-not $DisableAuth) {
    if ($ApiKey) {
      Write-Step "Creating local supervisor enrollment token..."
      $resp = Invoke-JsonRequest -Method POST -Url "$PublicUrl/api/v1/supervisors/enroll" -Body @{ name = "local-supervisor" } -Headers @{ Authorization = "Bearer $ApiKey" }
      $supervisorEnrollmentToken = $resp.token
      Write-Step "✓ Enrollment token issued"
    } else {
      Write-Host "  ! Skipping supervisor auto-install because auth is enabled and no -ApiKey was provided."
      Write-Host "    Add a supervisor later from Hosts, or rerun with -ApiKey."
    }
  }

  if ($DisableAuth -or $supervisorEnrollmentToken) {
    $trustedRoot = Join-Path $HOME "dev"
    if (-not (Test-Path $trustedRoot)) { $trustedRoot = $HOME }
    $supervisorConfig = @{}
    if (Test-Path $SupervisorConfigPath) {
      $supervisorConfig = Get-Content $SupervisorConfigPath -Raw | ConvertFrom-Json -AsHashtable
    }
    $supervisorConfig["serverUrl"] = $PublicUrl
    if (-not $supervisorConfig["hostName"]) { $supervisorConfig["hostName"] = $env:COMPUTERNAME }
    if (-not $supervisorConfig["trustedRoots"]) { $supervisorConfig["trustedRoots"] = @($trustedRoot) }
    if ($ApiKey) { $supervisorConfig["apiKey"] = $ApiKey }
    if ($supervisorEnrollmentToken) { $supervisorConfig["enrollmentToken"] = $supervisorEnrollmentToken }
    $claude = Get-Command claude -ErrorAction SilentlyContinue
    $codex = Get-Command codex -ErrorAction SilentlyContinue
    if ($claude) { $supervisorConfig["claudeCommand"] = $claude.Source }
    if ($codex) { $supervisorConfig["codexCommand"] = $codex.Source }
    Set-JsonFile -Path $SupervisorConfigPath -Data $supervisorConfig
    Write-Step "✓ Wrote $SupervisorConfigPath"

    @"
`$env:PORT = "$Port"
`$env:HOST = "$HostName"
`$env:PUBLIC_URL = "$PublicUrl"
`$env:DISABLE_AUTH = "$DisableAuth"
`$env:AGENTPULSE_INITIAL_API_KEY = "$ApiKey"
`$env:DATA_DIR = "$DataDir"
`$env:SQLITE_PATH = "$DataDir\agentpulse.db"
`$env:NODE_ENV = "production"
`$env:HOME = "$HOME"
`$env:PATH = "$([System.IO.Path]::GetDirectoryName($bun));$env:PATH"
Set-Location "$Dir"
& "$bun" run supervisor *>> "$supervisorLog" 2>> "$supervisorErr"
"@ | Set-Content -Path $supervisorScript -Encoding UTF8

    Register-OrUpdateTask -TaskName $SupervisorTask -ScriptPath $supervisorScript -Description "AgentPulse local supervisor"
    Start-TaskNow -ScriptPath $supervisorScript
    Write-Step "✓ Scheduled local supervisor"
    Write-Host ""
  }
}

if (-not $SkipHooks) {
  if ($DisableAuth) {
    Configure-Hooks
  } elseif ($ApiKey) {
    Configure-Hooks
  } else {
    Write-Host "  ! Skipping automatic hook setup because auth is enabled and no -ApiKey was provided."
    Write-Host "    Re-run the installer with -ApiKey to configure hooks automatically."
    Write-Host ""
  }
}

Write-Host "  Local control plane:"
if ($SkipSupervisor) {
  Write-Host "    skipped (-SkipSupervisor)"
} else {
  Write-Host "    enabled"
}
Write-Host "  Open:"
Write-Host "    $PublicUrl"
