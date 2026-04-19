param(
  [string]$Ref = "main",
  [string]$Repo = "https://github.com/jaystuart/agentpulse.git",
  [string]$Dir = "$HOME\.agentpulse\app",
  [string]$DataDir = "$HOME\.agentpulse\data",
  [int]$Port = 3000,
  [string]$HostName = "0.0.0.0",
  [string]$PublicUrl = "",
  [bool]$DisableAuth = $true,
  [string]$ApiKey = "",
  [switch]$SkipHooks,
  [switch]$SkipSupervisor
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

function Configure-Hooks {
  Write-Step "Configuring Claude Code + Codex hooks..."

  $hookHeadersClaude = @{ "X-Agent-Type" = "claude_code" }
  $hookHeadersCodex = @{ "X-Agent-Type" = "codex_cli" }
  if ($ApiKey) {
    $hookHeadersClaude["Authorization"] = "Bearer $ApiKey"
    $hookHeadersCodex["Authorization"] = "Bearer $ApiKey"
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
  foreach ($eventName in @("SessionStart","SessionEnd","PreToolUse","PostToolUse","Stop","SubagentStart","SubagentStop","TaskCreated","TaskCompleted","UserPromptSubmit")) {
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

  $codexDir = Join-Path $HOME ".codex"
  Ensure-Dir $codexDir
  $codexHooks = @{
    hooks = @(
      @{ event = "SessionStart"; type = "http"; url = "$PublicUrl/api/v1/hooks"; async = $true; headers = $hookHeadersCodex },
      @{ event = "PreToolUse"; type = "http"; url = "$PublicUrl/api/v1/hooks"; async = $true; headers = $hookHeadersCodex },
      @{ event = "PostToolUse"; type = "http"; url = "$PublicUrl/api/v1/hooks"; async = $true; headers = $hookHeadersCodex },
      @{ event = "UserPromptSubmit"; type = "http"; url = "$PublicUrl/api/v1/hooks"; async = $true; headers = $hookHeadersCodex },
      @{ event = "Stop"; type = "http"; url = "$PublicUrl/api/v1/hooks"; async = $true; headers = $hookHeadersCodex }
    )
  }
  Set-JsonFile -Path (Join-Path $codexDir "hooks.json") -Data $codexHooks

  $codexConfig = Join-Path $codexDir "config.toml"
  $featureBlock = "[features]`ncodex_hooks = true`n"
  if (Test-Path $codexConfig) {
    $content = Get-Content $codexConfig -Raw
    if ($content -notmatch "codex_hooks") {
      Add-Content -Path $codexConfig -Value "`n$featureBlock"
    }
  } else {
    Set-Content -Path $codexConfig -Value $featureBlock -Encoding UTF8
  }

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
