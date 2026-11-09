# The OpenCode step of install-local.ps1 (AGEN-141). A template: `bun run embed:opencode-plugin`
# fills the @@AP_OC_*@@ lines from src/shared/opencode-plugin.ts and writes the result between
# the OPENCODE_INSTALL_PS1 markers of install-local.ps1. This has never been executed on Windows.
# It never runs `opencode`.
# In the all-gated layout -OpenCodeForce is remembered in a small file under .agentpulse; only -NoOpenCode
# clears it (and it removes the plugins too). Outside that layout nothing is remembered.
@@AP_OC_DATA@@

@@AP_OC_GATE@@

function Test-ApOcLink {
  param([Parameter(Mandatory = $true)][string]$Path)
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  return [bool]($item -and (Get-Item -LiteralPath $Path -Force).LinkType)
}

function Get-ApOcRooted {
  param([string]$Value)
  return ($Value -and [System.IO.Path]::IsPathRooted($Value))
}

function Get-ApOcConfigDir {
  if (Get-ApOcRooted $env:OPENCODE_CONFIG_DIR) { $script:ApOcFromEnv = $true; return $env:OPENCODE_CONFIG_DIR.TrimEnd('\', '/') }
  $script:ApOcFromEnv = $false
  if (Get-ApOcRooted $env:XDG_CONFIG_HOME) { return (Join-Path $env:XDG_CONFIG_HOME.TrimEnd('\', '/') 'opencode') }
  return (Join-Path $HOME '.config\opencode')
}

function Get-ApOcDataDir {
  if (Get-ApOcRooted $env:XDG_DATA_HOME) { return (Join-Path $env:XDG_DATA_HOME.TrimEnd('\', '/') 'opencode') }
  return (Join-Path $HOME '.local\share\opencode')
}

function Test-ApOcOurHeader {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  $first = Get-Content -LiteralPath $Path -TotalCount 1
  return [bool]($first -and $first.StartsWith($script:ApOcHeaderPrefix))
}

function Move-ApOcToBackups {
  param([Parameter(Mandatory = $true)][string]$Path)
  $dir = Join-Path $HOME '.agentpulse\backups\opencode'
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $name = "{0}.{1}" -f (Split-Path -Leaf $Path), (Get-Date -AsUTC -Format 'yyyyMMddTHHmmssZ')
  $to = Join-Path $dir $name
  $n = 0
  while (Test-Path -LiteralPath $to) { $n++; $to = Join-Path $dir "$name.$n" }
  Move-Item -LiteralPath $Path -Destination $to
  Write-Step "Moved $Path to $to"
}

function Remove-ApOcOurs {
  param([string]$Plugins, $Entry)
  $top = Join-Path $Plugins $Entry.Name
  if (-not (Test-Path -LiteralPath $top)) { return }
  if ($Entry.Kind -eq 'file') {
    if (Test-ApOcOurHeader -Path $top) {
      Remove-Item -LiteralPath $top -Force
      Write-Step "Removed OpenCode plugin $top"
    }
    return
  }
  $index = Join-Path $top 'index.js'
  if (-not (Test-ApOcOurHeader -Path $index)) { return }
  $others = @(Get-ChildItem -LiteralPath $top -Force | Where-Object { $_.Name -ne 'index.js' })
  if ($others.Count -eq 0) {
    Remove-Item -LiteralPath $index -Force
    Remove-Item -LiteralPath $top -Force
    Write-Step "Removed OpenCode plugin $top"
  } else {
    Move-ApOcToBackups -Path $top
  }
}

function Write-ApOcEntry {
  param([string]$Plugins, $Entry, [string]$BaseUrl, [bool]$Direct)
  $template = if ($Entry.Line -eq 1) { $ApOpenCodePlugin1Template } else { $ApOpenCodePlugin2Template }
  $text = $template.TrimEnd("`r", "`n").Replace('@@AP_OPENCODE_BASE_URL@@', $BaseUrl).Replace('@@AP_OPENCODE_DIRECT@@', $(if ($Direct) { '1' } else { '0' }))
  # Exactly one line break at the end, as buildOpenCodePluginFiles' text has.
  $text = $text + "`n"
  $abs = Join-Path $Plugins $Entry.File
  $top = Join-Path $Plugins $Entry.Name
  if ($Entry.Kind -eq 'dir' -and (Test-Path -LiteralPath $top -PathType Leaf)) { Move-ApOcToBackups -Path $top }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $abs) | Out-Null
  if (Test-Path -LiteralPath $abs -PathType Leaf) {
    if ([System.IO.File]::ReadAllText($abs) -ceq $text) {
      Write-Step "OpenCode plugin unchanged: $abs"
      return
    }
    if (-not (Test-ApOcOurHeader -Path $abs)) { Move-ApOcToBackups -Path $abs }
  }
  Write-ApFileNoFollow -Path $abs -Content $text
  Write-Step "OpenCode plugin -> $abs"
}

function Test-ApOcDetected {
  $cfg = Get-ApOcConfigDir
  return [bool]((Get-Command opencode -ErrorAction SilentlyContinue) -or (Test-Path -LiteralPath $cfg) -or (Test-Path -LiteralPath (Get-ApOcDataDir)))
}

# Returns $false only when it refused because something it would touch is a link.
function Install-ApOpenCode {
  param([string]$BaseUrl, [bool]$Direct, [bool]$Force, [bool]$NoOpenCode)
  $cfg = Get-ApOcConfigDir
  if ([string]::IsNullOrEmpty($cfg) -or $cfg -match '^([A-Za-z]:)?$') {
    Write-Warning "OpenCode: refusing to use a drive or filesystem root as OpenCode's config folder (check OPENCODE_CONFIG_DIR). No OpenCode plugin was written or removed."
    return $false
  }
  $plugins = Join-Path $cfg 'plugins'
  if (-not $NoOpenCode -and -not (Test-ApOcDetected)) {
    Write-Step 'OpenCode not detected (no opencode on PATH, no config or data folder); nothing written.'
    return $true
  }
  if (-not $NoOpenCode) {
    # \z, not $: .NET's $ also matches before a final line break. The same explicit rejects as the shell and CLI installers.
    if ($BaseUrl -notmatch '^https?://([A-Za-z0-9.-]+|\[[0-9A-Fa-f:]+\])(:[0-9]{1,5})?\z' -or $BaseUrl -match '["\\\r\n]' -or $BaseUrl.Contains('@@')) {
      Write-Warning "invalid AgentPulse base URL for the OpenCode plugin: $BaseUrl"
      return $false
    }
  }
  foreach ($p in (@($cfg, $plugins) + @($script:ApOcEntries | ForEach-Object { Join-Path $plugins $_.Name }))) {
    if (Test-ApOcLink -Path $p) {
      Write-Warning "OpenCode: refusing to touch ${p}: it is a link. No OpenCode plugin was written or removed."
      return $false
    }
  }
  try {
  if ($NoOpenCode) {
    foreach ($entry in $script:ApOcEntries) { Remove-ApOcOurs -Plugins $plugins -Entry $entry }
@@AP_OC_NOOP_MARKER@@
    Write-Step 'OpenCode plugins removed (-NoOpenCode).'
    return $true
  }
  $sdk = Test-Path -LiteralPath (Join-Path $cfg $script:ApOcSdkMarker) -PathType Leaf
  if ($sdk -and $script:ApOcSdkCheck -ne 'marker_only') {
    $pkg = Join-Path $cfg 'package.json'
    $sdk = (Test-Path -LiteralPath $pkg -PathType Leaf) -and [bool](Select-String -LiteralPath $pkg -SimpleMatch $script:ApOcSdkConfigDep -Quiet)
  }
  $foreign = Test-ApOcForeignPlugin -Plugins $plugins
@@AP_OC_REMEMBERED@@
  $rule = Test-ApOcGateOpen -Sdk $sdk -Foreign $foreign -Force $false -Remembered $false
  $open = Test-ApOcGateOpen -Sdk $sdk -Foreign $foreign -Force $Force -Remembered $remembered
  $touched = $false
  foreach ($entry in $script:ApOcEntries) {
    if ($entry.Gated -and -not $open) {
      Remove-ApOcOurs -Plugins $plugins -Entry $entry
    } else {
      Write-ApOcEntry -Plugins $plugins -Entry $entry -BaseUrl $BaseUrl -Direct $Direct
      $touched = $true
    }
  }
@@AP_OC_WRITE_MARKER@@
  if ($script:ApOcFromEnv) { Write-Step "OPENCODE_CONFIG_DIR is set; installing into $cfg\plugins." }
  if (-not $open) {
    Write-Step $script:ApOcMsgSkip.Replace('<dir>', $cfg)
  } elseif ($Force -and -not $rule) {
    Write-Step $script:ApOcMsgForce.Replace('<dir>', $cfg)
  }
  if ($touched) {
    Write-Step $script:ApOcNoteServerFirst
    Write-Step $script:ApOcNoteServiceSkip
  }
  return $true
  } catch {
    Write-Warning "OpenCode: stopped, and the plugins may be partly installed: $($_.Exception.Message)"
    return $false
  }
}
