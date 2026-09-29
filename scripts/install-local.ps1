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
  $markerLine = ""
  if ($AgentType -eq "codex_cli") {
    $markerLine = "`$sid = [regex]::Match(`$raw, '`"session_id`"\s*:\s*`"([A-Za-z0-9-]{1,128})`"').Groups[1].Value; if (`$sid) { `$md = Join-Path `$HOME '.agentpulse\codex-native'; New-Item -ItemType Directory -Force `$md -ErrorAction SilentlyContinue | Out-Null; New-Item -ItemType File -Force (Join-Path `$md `$sid) -ErrorAction SilentlyContinue | Out-Null }`n"
  }
  return (
    "`$ErrorActionPreference = 'SilentlyContinue'`n" +
    "`$d = Join-Path `$env:TEMP 'agentpulse-hooks'`n" +
    "New-Item -ItemType Directory -Force `$d | Out-Null`n" +
    "`$t = Join-Path `$d ([guid]::NewGuid().ToString())`n" +
    "`$raw = [Console]::In.ReadToEnd()`n" +
    "[IO.File]::WriteAllText(`$t, `$raw)`n" +
    $headerFileLine +
    $markerLine +
    "Start-Job -ScriptBlock {`n" +
    "  param(`$t, `$f, `$url, `$agent)`n" +
    "  `$headerArgs = $authArg`n" +
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
function New-ApHookAuthHeaderFile {
  param([Parameter(Mandatory = $true)][string]$ApiKey)
  $d = Join-Path $HOME ".agentpulse"
  New-Item -ItemType Directory -Force -Path $d | Out-Null
  icacls $d /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
  $f = Join-Path $d "hook-auth-header"
  Set-Content -NoNewline -Path $f -Value "Authorization: Bearer $ApiKey`n" -Encoding UTF8
  icacls $f /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
}
# <<< agentpulse-hook-cmd

function Configure-Hooks {
  Write-Step "Configuring Claude Code + Codex hooks..."

  $hookHeadersClaude = @{ "X-Agent-Type" = "claude_code" }
  if ($ApiKey) {
    $hookHeadersClaude["Authorization"] = "Bearer $ApiKey"
  }

  $claudeDir = Join-Path $HOME ".claude"
  $claudeSettings = Join-Path $claudeDir "settings.json"
  Ensure-Dir $claudeDir
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
      $hook.hooks[0]["headers"]["Authorization"] = "Bearer `$env:AGENTPULSE_API_KEY"
    }
    $claudeData["hooks"][$eventName] = @($hook)
  }
  Set-JsonFile -Path $claudeSettings -Data $claudeData

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
      Copy-Item -Path $codexHooksFile -Destination $codexBackupFile
      Write-Step "Backed up existing Codex hooks to $codexBackupFile"
    }
    Set-Content -NoNewline -Path $codexHooksFile -Value $newCodexHooksJson -Encoding UTF8
    Write-Step "Codex CLI hooks configured"
    Write-Step "Open Codex and run /hooks, then trust the AgentPulse hooks — Codex silently skips untrusted hooks."
    Write-Step "Re-trust after changing the AgentPulse URL or port."
  }
  # D12: codex_hooks is a deprecated (but still-working) legacy alias for
  # [features].hooks — left alone if present, never newly written.

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
