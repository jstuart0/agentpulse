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
# The exclusion check is NOT inlined in the hook commands. It is two installed
# scripts, ~/.agentpulse/exclude-check.sh (run by Copilot's bash handler) and
# ~/.agentpulse/exclude-check.ps1 (run by the PowerShell handlers), written by
# Install-ApExcludeScripts, and each hook command runs one only when a rules file
# exists. Everything below is literal text held byte-identical to
# src/shared/hook-command.ts by scripts/hook-command-parity.test.ts: both scripts,
# the two command templates, and the pieces that fill them. The shell script holds
# three placeholders for the characters it needs as real bytes (tab, carriage
# return, byte order mark), restored when it is written. Never executed on
# Windows by anything in this change.
$script:ApExcludePsScript = @'
# agentpulse-exclude-check 0ab94c52bff92b
# Trust: the hook command runs this file only when it and ~/.agentpulse are owned by you
# and not group- or world-writable. Only that directory and this file are checked, not the
# directory's ancestors: a ~/.agentpulse symlink that points under a directory other users
# can write is not protected.
$apDir = Join-Path $HOME '.agentpulse'
$apRules = Join-Path $apDir 'exclude'
$apMarker = Join-Path $apDir 'exclude.invalid'
$apExcluded = $false
$apValid = $true
$apDirOk = $true
$apMatch = $false
$apNRules = 0

function ApIsReparsePoint($apPath) {
  $apItem = Get-Item -LiteralPath $apPath -Force -ErrorAction SilentlyContinue
  if (-not $apItem) { return $false }
  if ($apItem.LinkType) { return $true }
  return [bool]($apItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
}

function ApHasMultipleHardLinks($apPath) {
  if (-not (Test-Path -LiteralPath $apPath)) { return $false }
  try {
    $apOutput = & fsutil hardlink list $apPath 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $apOutput) { return $false }
    $apCount = @($apOutput | Where-Object { $_.Trim().Length -gt 0 }).Count
    return $apCount -gt 1
  } catch {
    return $false
  }
}

function ApCheckSecurity($apPath) {
  try {
    $apAcl = Get-Acl -LiteralPath $apPath -ErrorAction Stop
  } catch {
    return $false
  }
  $apCurrentSid = $null
  try { $apCurrentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch {}
  if (-not $apCurrentSid) { return $false }
  $apOwnerSid = $null
  try { $apOwnerSid = $apAcl.Owner.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
  if (-not $apOwnerSid) {
    try { $apOwnerSid = ([System.Security.Principal.NTAccount]$apAcl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
  }
  $apExempt = @($apCurrentSid, 'S-1-5-18', 'S-1-5-32-544')
  if (-not $apOwnerSid -or -not ($apExempt -contains $apOwnerSid)) { return $false }
  $apWriteNames = @('WriteData','AppendData','WriteAttributes','WriteExtendedAttributes','WriteDac','ChangePermissions','WriteOwner','TakeOwnership','Delete','DeleteSubdirectoriesAndFiles','Modify','FullControl','Write','GenericWrite','GenericAll')
  $apWriteRightsMask = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x40000000 -bor 0x10000000
  foreach ($apAce in $apAcl.Access) {
    if ($apAce.AccessControlType.ToString() -ne 'Allow') { continue }
    $apRightsStr = $apAce.FileSystemRights.ToString().Trim()
    $apHasWrite = $false
    if ($apRightsStr -match '^-?\d+$') {
      if (([int64]$apRightsStr -band $apWriteRightsMask) -ne 0) { $apHasWrite = $true }
    } else {
      foreach ($apName in ($apRightsStr -split ',')) {
        if ($apWriteNames -contains $apName.Trim()) { $apHasWrite = $true; break }
      }
    }
    if (-not $apHasWrite) { continue }
    $apAceSid = $null
    try { $apAceSid = $apAce.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
    if ($apAceSid -and ($apExempt -contains $apAceSid)) { continue }
    return $false
  }
  return $true
}

function ApResolveLinks($apPath, $apDepth) {
  if ($apDepth -gt 32) { return $null }
  $apRoot = [System.IO.Path]::GetPathRoot($apPath)
  if ([string]::IsNullOrEmpty($apRoot)) { return $apPath }
  $apCur = $apRoot
  foreach ($apSeg in ($apPath.Substring($apRoot.Length) -split '[\\/]' | Where-Object { $_.Length -gt 0 })) {
    $apNext = Join-Path $apCur $apSeg
    $apItem = Get-Item -LiteralPath $apNext -Force -ErrorAction SilentlyContinue
    if ($apItem -and $apItem.LinkType) {
      $apTarget = @($apItem.Target)[0]
      if (-not [System.IO.Path]::IsPathRooted($apTarget)) { $apTarget = Join-Path $apCur $apTarget }
      $apNext = ApResolveLinks ([System.IO.Path]::GetFullPath($apTarget)) ($apDepth + 1)
      if ($null -eq $apNext) { return $null }
    }
    $apCur = $apNext
  }
  return $apCur
}

function ApResolve($apTarget) {
  $apFull = $apTarget
  try { $apFull = [System.IO.Path]::GetFullPath($apTarget) } catch {}
  $apOut = ApResolveLinks $apFull 0
  if ($null -eq $apOut) { return $apFull }
  return $apOut
}

$apSkipTrimmed = $env:AGENTPULSE_SKIP
if ($null -eq $apSkipTrimmed) { $apSkipTrimmed = '' }
$apSkipTrimmed = $apSkipTrimmed.Trim(' ', "`t", "`r", "`n").ToLowerInvariant()
if ([Array]::IndexOf(@('1','true','yes','on'), $apSkipTrimmed) -ge 0) { $apExcluded = $true }

$apPresent = $false
$apLookupError = $false
if (-not $apExcluded) {
  if ([string]::IsNullOrEmpty($HOME)) {
    $apExcluded = $true
  } else {
    try {
      $null = Get-Item -LiteralPath $apRules -Force -ErrorAction Stop
      $apPresent = $true
    } catch [System.Management.Automation.ItemNotFoundException] {
      $apPresent = $false
    } catch [System.Management.Automation.DriveNotFoundException] {
      $apPresent = $false
    } catch {
      $apPresent = $true
      $apLookupError = $true
    }
    if (-not $apPresent) {
      $apDirItem = Get-Item -LiteralPath $apDir -Force -ErrorAction SilentlyContinue
      if ($apDirItem -and $apDirItem.LinkType -and -not (Test-Path -LiteralPath $apDir)) {
        $apPresent = $true
        $apLookupError = $true
      }
    }
  }
}

if (-not $apPresent -and -not $apExcluded) {
  if (Test-Path -LiteralPath $apMarker) {
    $apDirReal = ApResolveLinks $apDir 0
    if (-not [string]::IsNullOrEmpty($apDirReal) -and (Test-Path -LiteralPath $apDirReal -PathType Container) -and (ApCheckSecurity $apDirReal)) {
      Remove-Item -LiteralPath (Join-Path $apDirReal 'exclude.invalid') -Force -ErrorAction SilentlyContinue
    }
  }
}

if ($apPresent) {
  $apDirReal = ApResolveLinks $apDir 0
  if ($apLookupError -or [string]::IsNullOrEmpty($apDirReal)) {
    $apDirOk = $false
  } elseif (-not (Test-Path -LiteralPath $apDirReal -PathType Container -ErrorAction SilentlyContinue)) {
    $apDirOk = $false
  } elseif (-not (ApCheckSecurity $apDirReal)) {
    $apDirOk = $false
  }
  $apValid = $apDirOk
  if ($apDirOk) {
    $apRules = Join-Path $apDirReal 'exclude'
    $apMarker = Join-Path $apDirReal 'exclude.invalid'
  }

  if ($apValid) {
    if (ApIsReparsePoint $apRules) {
      $apValid = $false
    } elseif (Test-Path -LiteralPath $apRules -PathType Container) {
      $apValid = $false
    } elseif (ApHasMultipleHardLinks $apRules) {
      $apValid = $false
    } elseif (-not (ApCheckSecurity $apRules)) {
      $apValid = $false
    } else {
      $apInfo = Get-Item -LiteralPath $apRules -Force -ErrorAction SilentlyContinue
      if ($null -eq $apInfo -or $apInfo.Length -gt 65536) { $apValid = $false }
    }
  }

  if ($apValid) {
    $apCwd = ApResolveLinks ((Get-Location).Path) 0
    $apText = $null
    try {
      $apText = [System.IO.File]::ReadAllText($apRules, (New-Object System.Text.UTF8Encoding($false)))
    } catch { $apValid = $false }
    if ($null -eq $apText) { $apValid = $false }
  }

  if ($apValid) {
    $apCwdCmp = ''
    if (-not [string]::IsNullOrEmpty($apCwd)) { $apCwdCmp = $apCwd.Replace('/', '\').ToLowerInvariant() }
    foreach ($apRawLine in ($apText -split "`n")) {
      $apLine = $apRawLine
      if ($apLine.EndsWith("`r")) { $apLine = $apLine.Substring(0, $apLine.Length - 1) }
      $apLine = $apLine.TrimEnd(' ', "`t")
      if ($apLine.Length -eq 0) { continue }
      if ($apLine.StartsWith('#')) { continue }
      $apNRules = $apNRules + 1
      if ($apNRules -gt 500) { $apValid = $false; break }
      if ($apLine -match '[*?\[\]]') { $apValid = $false; break }
      $apIsAbsolute = $apLine.StartsWith('/') -or $apLine -eq '~' -or $apLine.StartsWith('~/') -or ($apLine -match '^[A-Za-z]:[\\/]')
      if (-not $apIsAbsolute) { $apValid = $false; break }
      $apSegments = $apLine -split '[\\/]' | Where-Object { $_.Length -gt 0 }
      if (($apSegments -contains '.') -or ($apSegments -contains '..')) { $apValid = $false; break }
      if ($apMatch) { continue }
      if ($apLine -eq '~') {
        $apExpanded = $HOME
      } elseif ($apLine.StartsWith('~/')) {
        $apExpanded = Join-Path $HOME ($apLine.Substring(2))
      } else {
        $apExpanded = $apLine
      }
      $apResolved = ApResolve $apExpanded
      if ($apResolved -notmatch '^[A-Za-z]:[\\/]' -and -not $apResolved.StartsWith('\\')) { $apValid = $false; break }
      $apResolvedCmp = $apResolved.Replace('/', '\').ToLowerInvariant()
      $apResolvedIsRoot = $apResolvedCmp -match '^[a-z]:\\$'
      $apResolvedWithSep = if ($apResolvedIsRoot) { $apResolvedCmp } else { "$apResolvedCmp\" }
      if ([string]::Equals($apCwdCmp, $apResolvedCmp, 'Ordinal') -or $apCwdCmp.StartsWith($apResolvedWithSep, 'Ordinal')) {
        $apMatch = $true
      }
    }
    if ($apValid -and $apNRules -gt 0 -and [string]::IsNullOrEmpty($apCwd)) { $apMatch = $true }
  }

  if ($apValid) {
    Remove-Item -LiteralPath $apMarker -Force -ErrorAction SilentlyContinue
    if ($apMatch) { $apExcluded = $true }
  } else {
    if ($apDirOk -and -not (ApIsReparsePoint $apMarker)) {
      try {
        $apFs = [System.IO.File]::Open($apMarker, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
        $apFs.Close()
      } catch {}
    }
    $apExcluded = $true
  }
}
if ($apExcluded) { exit 1 }
exit 42
'@

$script:ApExcludeBashScript = @'
#!/bin/sh
# agentpulse-exclude-check 1eceddec1f369c
# Trust: the hook command runs this file only when it and ~/.agentpulse are owned by you
# and not group- or world-writable. Only that directory and this file are checked, not the
# directory's ancestors: a ~/.agentpulse symlink that points under a directory other users
# can write is not protected.
ap_dir="$HOME/.agentpulse"
ap_rules="$ap_dir/exclude"
ap_marker="$ap_dir/exclude.invalid"
ap_excluded=0
ap_valid=1
ap_dir_ok=1
ap_match=0
ap_nrules=0
ap_cr='@@AP_CR@@'
ap_bom='@@AP_BOM@@'
ap_trimset=" @@AP_TAB@@$ap_cr
"
ap_ascii='] !"#$%&'\''()*+,./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\^_`abcdefghijklmnopqrstuvwxyz{|}~-'
ap_is_darwin=0
if [ -d /System/Library/CoreServices ]; then ap_is_darwin=1; fi

ap_lower() {
  ap_lc_in="$1"
  ap_lc_out=""
  while :; do
    case "$ap_lc_in" in
      *[ABCDEFGHIJKLMNOPQRSTUVWXYZ]*) : ;;
      *) break ;;
    esac
    ap_lc_pre=${ap_lc_in%%[ABCDEFGHIJKLMNOPQRSTUVWXYZ]*}
    ap_lc_in=${ap_lc_in#"$ap_lc_pre"}
    ap_lc_c=${ap_lc_in%"${ap_lc_in#?}"}
    ap_lc_in=${ap_lc_in#?}
    case "$ap_lc_c" in
      A) ap_lc_c=a ;; B) ap_lc_c=b ;; C) ap_lc_c=c ;; D) ap_lc_c=d ;; E) ap_lc_c=e ;;
      F) ap_lc_c=f ;; G) ap_lc_c=g ;; H) ap_lc_c=h ;; I) ap_lc_c=i ;; J) ap_lc_c=j ;;
      K) ap_lc_c=k ;; L) ap_lc_c=l ;; M) ap_lc_c=m ;; N) ap_lc_c=n ;; O) ap_lc_c=o ;;
      P) ap_lc_c=p ;; Q) ap_lc_c=q ;; R) ap_lc_c=r ;; S) ap_lc_c=s ;; T) ap_lc_c=t ;;
      U) ap_lc_c=u ;; V) ap_lc_c=v ;; W) ap_lc_c=w ;; X) ap_lc_c=x ;; Y) ap_lc_c=y ;;
      Z) ap_lc_c=z ;;
    esac
    ap_lc_out="$ap_lc_out$ap_lc_pre$ap_lc_c"
  done
  ap_lc_out="$ap_lc_out$ap_lc_in"
}

ap_stat() {
  ap_stat_mode=""
  ap_stat_line=$(LC_ALL=C LS_BLOCK_SIZE=1 BLOCK_SIZE=1 BLOCKSIZE=1 ls -ldn "$1" 2>/dev/null) || return 1
  IFS=" " read -r ap_stat_mode ap_stat_nlink ap_stat_uid ap_stat_gid ap_stat_size ap_stat_tail <<AP_STAT_EOF
$ap_stat_line
AP_STAT_EOF
  ap_stat_m=$ap_stat_mode
  case "$ap_stat_m" in *[@+.]) ap_stat_m=${ap_stat_m%?} ;; esac
  case "$ap_stat_m" in
    [-dlcbpsDw?][-r][-w][-xsS][-r][-w][-xsS][-r][-w][-xtT]) : ;;
    *) return 1 ;;
  esac
  case "$ap_stat_nlink" in ""|*[!0-9]*) return 1 ;; esac
  case "$ap_stat_uid" in ""|*[!0-9]*) return 1 ;; esac
  case "$ap_stat_size" in ""|*[!0-9]*) return 1 ;; esac
  ap_stat_rest=${ap_stat_m#?????}
  ap_stat_gw=${ap_stat_rest%"${ap_stat_rest#?}"}
  ap_stat_rest2=${ap_stat_m#????????}
  ap_stat_ow=${ap_stat_rest2%"${ap_stat_rest2#?}"}
  return 0
}

ap_physical() {
  if [ "$ap_is_darwin" = "1" ]; then
    case "$1" in
      *[!"$ap_ascii"]*) /bin/pwd -P 2>/dev/null; return ;;
    esac
  fi
  pwd -P 2>/dev/null
}

ap_skip_raw=${AGENTPULSE_SKIP:-}
while :; do
  case "$ap_skip_raw" in
    *["$ap_trimset"]) ap_skip_raw=${ap_skip_raw%?} ;;
    *) break ;;
  esac
done
while :; do
  case "$ap_skip_raw" in
    ["$ap_trimset"]*) ap_skip_raw=${ap_skip_raw#?} ;;
    *) break ;;
  esac
done
case "$ap_skip_raw" in
  [1]|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]) ap_excluded=1 ;;
esac

ap_present=0
if [ "$ap_excluded" != "1" ]; then
  if [ -z "$HOME" ]; then
    ap_excluded=1
  elif [ -e "$ap_rules" ] || [ -L "$ap_rules" ]; then
    ap_present=1
  else
    case "$ap_dir" in /*) ap_wp="" ;; *) ap_wp="." ;; esac
    ap_wrest=${ap_dir#/}
    while [ -n "$ap_wrest" ]; do
      case "$ap_wrest" in
        */*)
          ap_wseg=${ap_wrest%%/*}
          ap_wrest=${ap_wrest#*/}
          ;;
        *)
          ap_wseg="$ap_wrest"
          ap_wrest=""
          ;;
      esac
      if [ -z "$ap_wseg" ]; then continue; fi
      ap_wp="$ap_wp/$ap_wseg"
      if [ -L "$ap_wp" ] && [ ! -e "$ap_wp" ]; then ap_present=1; break; fi
      if [ -d "$ap_wp" ]; then
        if [ ! -x "$ap_wp" ]; then ap_present=1; break; fi
      else
        break
      fi
    done
  fi
fi

ap_check_dir() {
  ap_dir_ok=1
  if [ -L "$ap_dir" ]; then
    ap_dir_real=$(cd "$ap_dir" 2>/dev/null && pwd -P 2>/dev/null)
  else
    ap_dir_real="$ap_dir"
  fi
  if [ -z "$ap_dir_real" ] || [ ! -d "$ap_dir_real" ] || [ ! -x "$ap_dir_real" ]; then
    ap_dir_ok=0
  else
    ap_my_uid=$(id -u 2>/dev/null)
    case "$ap_my_uid" in ""|*[!0-9]*) ap_dir_ok=0 ;; esac
    if ap_stat "$ap_dir_real"; then
      if [ "$ap_stat_uid" != "$ap_my_uid" ]; then ap_dir_ok=0; fi
      if [ "$ap_stat_gw" = "w" ] || [ "$ap_stat_ow" = "w" ]; then ap_dir_ok=0; fi
    else
      ap_dir_ok=0
    fi
  fi
}

if [ "$ap_present" != "1" ] && [ "$ap_excluded" != "1" ]; then
  if [ -e "$ap_marker" ] || [ -L "$ap_marker" ]; then
    ap_check_dir
    if [ "$ap_dir_ok" = "1" ]; then rm -f "$ap_dir_real/exclude.invalid" 2>/dev/null; fi
  fi
fi

if [ "$ap_present" = "1" ]; then
  ap_check_dir
  ap_valid=$ap_dir_ok
  ap_marker="$ap_dir_real/exclude.invalid"

  if [ "$ap_valid" = "1" ]; then
    if [ -L "$ap_rules" ]; then
      ap_valid=0
    elif [ ! -f "$ap_rules" ]; then
      ap_valid=0
    elif ap_stat "$ap_rules"; then
      if [ "$ap_stat_nlink" -gt 1 ]; then ap_valid=0; fi
      if [ "$ap_stat_uid" != "$ap_my_uid" ]; then ap_valid=0; fi
      if [ "$ap_stat_gw" = "w" ] || [ "$ap_stat_ow" = "w" ]; then ap_valid=0; fi
      if [ "$ap_valid" = "1" ] && [ ! -r "$ap_rules" ]; then ap_valid=0; fi
      if [ "$ap_valid" = "1" ] && [ "$ap_stat_size" -gt 65536 ]; then ap_valid=0; fi
    else
      ap_valid=0
    fi
  fi

  if [ "$ap_valid" = "1" ]; then
    ap_cwd=$(pwd -P 2>/dev/null)
    if [ -n "$ap_cwd" ] && [ ! -d "$ap_cwd" ]; then ap_cwd=""; fi
    if [ "$ap_is_darwin" = "1" ]; then
      case "$ap_cwd" in
        *[!"$ap_ascii"]*) ap_cwd=$(/bin/pwd -P 2>/dev/null) ;;
      esac
      ap_lower "$ap_cwd"
      ap_cwd="$ap_lc_out"
    fi

    ap_line_no=0
    ap_read_ok=0
    {
    while IFS= read -r ap_line || [ -n "$ap_line" ]; do
      ap_line_no=$((ap_line_no + 1))
      case "$ap_line" in *"$ap_cr") ap_line=${ap_line%"$ap_cr"} ;; esac
      if [ "$ap_line_no" = "1" ]; then
        case "$ap_line" in "$ap_bom"*) ap_line=${ap_line#"$ap_bom"} ;; esac
      fi
      while :; do
        case "$ap_line" in
          *["$ap_trimset"]) ap_line=${ap_line%?} ;;
          *) break ;;
        esac
      done
      case "$ap_line" in
        "") continue ;;
        "#"*) continue ;;
      esac
      ap_nrules=$((ap_nrules + 1))
      if [ "$ap_nrules" -gt 500 ]; then ap_valid=0; break; fi
      case "$ap_line" in
        *'*'*|*'?'*|*'['*|*']'*) ap_valid=0; break ;;
      esac
      case "$ap_line" in
        /*) : ;;
        "~") : ;;
        "~/"*) : ;;
        *) ap_valid=0; break ;;
      esac
      case "$ap_line" in
        "~") ap_expanded="$HOME" ;;
        "~/"*) ap_expanded="$HOME/${ap_line#\~/}" ;;
        *) ap_expanded="$ap_line" ;;
      esac
      case "/$ap_expanded/" in
        *"/./"*|*"/../"*) ap_valid=0; break ;;
      esac
      if [ "$ap_match" = "1" ]; then continue; fi

      ap_seg_rest=${ap_expanded#/}
      ap_prefix=""
      ap_needs_resolve=0
      ap_deepest=""
      ap_remainder=""
      while [ -n "$ap_seg_rest" ]; do
        case "$ap_seg_rest" in
          */*)
            ap_seg=${ap_seg_rest%%/*}
            ap_seg_rest=${ap_seg_rest#*/}
            ;;
          *)
            ap_seg="$ap_seg_rest"
            ap_seg_rest=""
            ;;
        esac
        if [ -z "$ap_seg" ]; then continue; fi
        ap_prefix="$ap_prefix/$ap_seg"
        if [ -L "$ap_prefix" ]; then ap_needs_resolve=1; fi
        if [ -e "$ap_prefix" ]; then
          ap_deepest="$ap_prefix"
          ap_remainder=""
        else
          ap_remainder="$ap_remainder/$ap_seg"
        fi
      done
      if [ -z "$ap_prefix" ]; then ap_prefix="/"; fi
      if [ "$ap_is_darwin" = "1" ]; then
        case "$ap_deepest" in
          *[!abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/._-]*)
            case "$ap_deepest" in
              *[!"$ap_ascii"]*) ap_needs_resolve=1 ;;
            esac ;;
        esac
      fi

      if [ "$ap_needs_resolve" = "1" ]; then
        ap_rt="${ap_deepest:-/}"
        ap_rrem="$ap_remainder"
        while :; do
          ap_resolved=$(cd "$ap_rt" 2>/dev/null && ap_physical "$ap_rt")
          if [ -n "$ap_resolved" ]; then break; fi
          if [ "$ap_rt" = "/" ]; then ap_resolved="/"; break; fi
          ap_rrem="/${ap_rt##*/}$ap_rrem"
          ap_rt=${ap_rt%/*}
          if [ -z "$ap_rt" ]; then ap_rt="/"; fi
        done
        if [ "$ap_resolved" = "/" ]; then ap_resolved=""; fi
        ap_resolved="$ap_resolved$ap_rrem"
        if [ -z "$ap_resolved" ]; then ap_resolved="/"; fi
      else
        ap_resolved="$ap_prefix"
      fi

      if [ "$ap_is_darwin" = "1" ]; then
        ap_lower "$ap_resolved"
        ap_resolved="$ap_lc_out"
      fi

      if [ "$ap_resolved" = "/" ]; then
        ap_match=1
      elif [ "$ap_cwd" = "$ap_resolved" ]; then
        ap_match=1
      else
        ap_rem=${ap_cwd#"$ap_resolved"/}
        if [ "$ap_rem" != "$ap_cwd" ]; then ap_match=1; fi
      fi
    done
    ap_read_ok=1
    } 2>/dev/null < "$ap_rules"
    if [ "$ap_read_ok" != "1" ]; then ap_valid=0; fi
    if [ "$ap_valid" = "1" ] && [ "$ap_nrules" -gt 0 ] && [ -z "$ap_cwd" ]; then ap_match=1; fi
  fi

  if [ "$ap_valid" = "1" ]; then
    if [ -e "$ap_marker" ] || [ -L "$ap_marker" ]; then rm -f "$ap_marker" 2>/dev/null; fi
    if [ "$ap_match" = "1" ]; then ap_excluded=1; fi
  else
    if [ "$ap_dir_ok" = "1" ] && [ ! -L "$ap_marker" ]; then { :; } 2>/dev/null >"$ap_marker"; fi
    ap_excluded=1
  fi
fi
if [ "$ap_excluded" = "1" ]; then exit 1; fi
exit 42
'@

$script:ApShCommandTemplate = @'
t=$(mktemp "${TMPDIR:-/tmp}/agentpulse-hook.XXXXXX" 2>/dev/null) || exit 0; cat > "$t"; ( trap 'rm -f "$t"' EXIT; trap 'exit 1' HUP INT TERM; @@AP_MARKER@@@@AP_GATE@@@@AP_SEND@@ ) </dev/null >/dev/null 2>&1 & exit 0
'@

$script:ApShGatePiece = @'
w=$(printf ' \t\r\n.'); w=${w%.}; x=${AGENTPULSE_SKIP:-}; y=${x%%[!"$w"]*}; x=${x#"$y"}; y=${x##*[!"$w"]}; x=${x%"$y"}; case $x in 1|[Tt][Rr][Uu][Ee]|[Yy][Ee][Ss]|[Oo][Nn]) exit 0 ;; esac; d=$HOME/.agentpulse; g=0; if [ -n "$HOME" ] && [ ! -e "$d/exclude" ] && [ ! -L "$d/exclude" ] && [ ! -e "$d/exclude.invalid" ] && [ ! -L "$d/exclude.invalid" ]; then if [ -d "$d" ] && [ -x "$d" ]; then g=1; elif [ ! -e "$d" ] && [ ! -L "$d" ] && [ -d "$HOME" ] && [ -x "$HOME" ]; then g=1; fi; fi; if [ "$g" != 1 ]; then l=$(LC_ALL=C LS_BLOCK_SIZE=1 BLOCK_SIZE=1 BLOCKSIZE=1 ls -ldn "$d/" "$d/exclude-check.sh" 2>/dev/null) || exit 0; u=$(id -u 2>/dev/null); ap_f() { y=${x%%[!" "]*}; x=${x#"$y"}; y=${x%%" "*}; x=${x#"$y"}; }; ap_v() { x=$1; ap_f; k=${y%[@+.]}; ap_f; ap_f; [ -n "$y" ] && [ "$y" = "$u" ] && case $k in $2[-r][-w][-xsS][-r]-[-xsS][-r]-[-xtT]) ;; *) false ;; esac; }; n=${w#???}; ap_v "${l%%"$n"*}" d && ap_v "${l#*"$n"}" - && { /bin/sh "$d/exclude-check.sh"; [ $? = 42 ]; } || exit 0; fi; 
'@

$script:ApPsCommandTemplate = @'
$ErrorActionPreference = 'SilentlyContinue'
$d = Join-Path $env:TEMP 'agentpulse-hooks'
New-Item -ItemType Directory -Force $d | Out-Null
$t = Join-Path $d ([guid]::NewGuid().ToString())
$raw = [Console]::In.ReadToEnd()
[IO.File]::WriteAllText($t, $raw)
@@AP_HEADER_FILE@@
Start-Job -ScriptBlock {
  param($t, $f, $url, $agent, $apJobCwd, $apJobSkip)
  try {
@@AP_PRELUDE@@
@@AP_MARKER@@@@AP_GATE@@
  if ($apGo) {
    @@AP_AUTH_ARG@@
    $curlArgs = @('-sS','--max-time','2','-o','NUL','-X','POST',$url,'-H','Content-Type: application/json','-H',"X-Agent-Type: $agent") + $headerArgs + @('--data-binary',"@$t")
    Start-Process -FilePath curl.exe -WindowStyle Hidden -ArgumentList $curlArgs -Wait
  }
  } finally {
    Remove-Item -Force $t -ErrorAction SilentlyContinue
  }
} -ArgumentList $t, $f, '@@AP_URL@@', '@@AP_AGENT@@', (Get-Location).Path, $env:AGENTPULSE_SKIP | Out-Null
Get-ChildItem $d -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddMinutes(-5) } | Remove-Item -Force -ErrorAction SilentlyContinue
exit 0
'@

$script:ApPsPreludePiece = @'
  function ApIsReparsePoint($apPath) {
    $apItem = Get-Item -LiteralPath $apPath -Force -ErrorAction SilentlyContinue
    if (-not $apItem) { return $false }
    if ($apItem.LinkType) { return $true }
    return [bool]($apItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint)
  }
'@

$script:ApPsMarkerPiece = @'
$jobRaw = [IO.File]::ReadAllText($t); $sid = [regex]::Match($jobRaw, '"session_id"\s*:\s*"([A-Za-z0-9-]{1,128})"').Groups[1].Value; if ($sid) { $md = Join-Path $HOME '.agentpulse\codex-native'; if (-not (ApIsReparsePoint $md)) { New-Item -ItemType Directory -Force $md -ErrorAction SilentlyContinue | Out-Null; $mf = Join-Path $md $sid; if (-not (ApIsReparsePoint $mf)) { try { [IO.File]::Open($mf, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::ReadWrite).Close() } catch {} } } }
'@

$script:ApPsGatePiece = @'
  $apGo = $true
  $apSkip = $apJobSkip
  if ($null -eq $apSkip) { $apSkip = '' }
  if (@('1','true','yes','on') -contains $apSkip.Trim(' ', "`t", "`r", "`n").ToLowerInvariant()) { $apGo = $false }
  elseif ([string]::IsNullOrEmpty($HOME)) { $apGo = $false }
  else {
    $apDir = Join-Path $HOME '.agentpulse'
    $apHand = $false
    try { $null = Get-Item -LiteralPath (Join-Path $apDir 'exclude') -Force -ErrorAction Stop; $apHand = $true }
    catch [System.Management.Automation.ItemNotFoundException] { }
    catch [System.Management.Automation.DriveNotFoundException] { }
    catch { $apHand = $true }
    if (-not $apHand) {
      try { $null = Get-Item -LiteralPath (Join-Path $apDir 'exclude.invalid') -Force -ErrorAction Stop; $apHand = $true }
      catch [System.Management.Automation.ItemNotFoundException] { }
      catch [System.Management.Automation.DriveNotFoundException] { }
      catch { $apHand = $true }
    }
    if (-not $apHand) {
      $apDirItem = Get-Item -LiteralPath $apDir -Force -ErrorAction SilentlyContinue
      if ($apDirItem -and $apDirItem.LinkType -and -not (Test-Path -LiteralPath $apDir)) { $apHand = $true }
    }
    if ($apHand) {
      $apGo = $false
      function ApCheckSecurity($apPath) {
        try {
          $apAcl = Get-Acl -LiteralPath $apPath -ErrorAction Stop
        } catch {
          return $false
        }
        $apCurrentSid = $null
        try { $apCurrentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch {}
        if (-not $apCurrentSid) { return $false }
        $apOwnerSid = $null
        try { $apOwnerSid = $apAcl.Owner.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
        if (-not $apOwnerSid) {
          try { $apOwnerSid = ([System.Security.Principal.NTAccount]$apAcl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
        }
        $apExempt = @($apCurrentSid, 'S-1-5-18', 'S-1-5-32-544')
        if (-not $apOwnerSid -or -not ($apExempt -contains $apOwnerSid)) { return $false }
        $apWriteNames = @('WriteData','AppendData','WriteAttributes','WriteExtendedAttributes','WriteDac','ChangePermissions','WriteOwner','TakeOwnership','Delete','DeleteSubdirectoriesAndFiles','Modify','FullControl','Write','GenericWrite','GenericAll')
        $apWriteRightsMask = 0x2 -bor 0x4 -bor 0x10 -bor 0x40 -bor 0x100 -bor 0x10000 -bor 0x40000 -bor 0x80000 -bor 0x40000000 -bor 0x10000000
        foreach ($apAce in $apAcl.Access) {
          if ($apAce.AccessControlType.ToString() -ne 'Allow') { continue }
          $apRightsStr = $apAce.FileSystemRights.ToString().Trim()
          $apHasWrite = $false
          if ($apRightsStr -match '^-?\d+$') {
            if (([int64]$apRightsStr -band $apWriteRightsMask) -ne 0) { $apHasWrite = $true }
          } else {
            foreach ($apName in ($apRightsStr -split ',')) {
              if ($apWriteNames -contains $apName.Trim()) { $apHasWrite = $true; break }
            }
          }
          if (-not $apHasWrite) { continue }
          $apAceSid = $null
          try { $apAceSid = $apAce.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}
          if ($apAceSid -and ($apExempt -contains $apAceSid)) { continue }
          return $false
        }
        return $true
      }
      $apScript = Join-Path $apDir 'exclude-check.ps1'
      if ((Test-Path -LiteralPath $apScript -PathType Leaf) -and -not (ApIsReparsePoint $apScript) -and (ApCheckSecurity $apDir) -and (ApCheckSecurity $apScript)) {
        $apHost = (Get-Process -Id $PID).Path
        $apProc = Start-Process -FilePath $apHost -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"' + $apScript + '"')) -WorkingDirectory $apJobCwd -WindowStyle Hidden -Wait -PassThru
        if ($apProc -and $apProc.ExitCode -eq 42) { $apGo = $true }
      }
    }
  }
'@

# A checkout that converts line endings must not change any of the text above.
foreach ($apName in @('ApExcludePsScript','ApExcludeBashScript','ApShCommandTemplate','ApShGatePiece','ApPsCommandTemplate','ApPsPreludePiece','ApPsMarkerPiece','ApPsGatePiece')) {
  Set-Variable -Scope Script -Name $apName -Value ((Get-Variable -Scope Script -Name $apName -ValueOnly).Replace("`r`n", "`n"))
}

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
  $headerFile = if ($Direct) { "`$f = Join-Path `$HOME '.agentpulse\hook-auth-header'" } else { "`$f = `$null" }
  $authArg = "`$headerArgs = @()`n    if (`$f -and (Test-Path `$f -ErrorAction SilentlyContinue) -and (Get-Item `$f -ErrorAction SilentlyContinue).Length -gt 0) { `$headerArgs = @('-H', `"@`$f`") }"
  # The marker runs INSIDE the Start-Job block, reading the temp file there; the
  # parent only drains stdin and writes the temp file.
  $marker = ""
  if ($AgentType -eq "codex_cli") {
    $marker = "  " + $script:ApPsMarkerPiece + "`n"
  }
  # The template, and the pieces that fill it, are the generator's text (see above);
  # each hole is filled by one plain substitution.
  $command = $script:ApPsCommandTemplate + "`n"
  $command = $command.Replace('@@AP_HEADER_FILE@@', $headerFile)
  $command = $command.Replace('@@AP_PRELUDE@@', $script:ApPsPreludePiece)
  $command = $command.Replace('@@AP_MARKER@@', $marker)
  $command = $command.Replace('@@AP_GATE@@', $script:ApPsGatePiece)
  $command = $command.Replace('@@AP_AUTH_ARG@@', $authArg)
  $command = $command.Replace('@@AP_URL@@', $url)
  $command = $command.Replace('@@AP_AGENT@@', $AgentType)
  return $command
}

# ConvertTo-Json writes ', <, > and & as \uXXXX and leaves other non-ASCII
# characters raw; the TypeScript and shell writers do the opposite (those four
# raw, every character outside space..~ as a lowercase \uXXXX). Normalise to the
# shared form so the same hooks compare equal across installers and Codex isn't
# asked to approve them again. Never executed on Windows by anything in this change.
function ConvertTo-ApHooksJson {
  param([Parameter(Mandatory = $true)][object]$Data)
  $json = $Data | ConvertTo-Json -Depth 100
  $json = [regex]::Replace($json, '\\u(0027|003c|003e|0026)', { param($m) [string][char][Convert]::ToInt32($m.Groups[1].Value, 16) }, 'IgnoreCase')
  $json = [regex]::Replace($json, '[^\x20-\x7e\r\n]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
  return $json + "`n"
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
  return ConvertTo-ApHooksJson -Data $obj
}

# Merging AgentPulse's Codex hooks into an existing hooks.json (the sh copy is
# ap_codex_merge_hooks_json, the reference is mergeCodexHooksFile in
# src/shared/hook-command.ts; scripts/codex-hooks-merge.test.ts holds the
# markers and the flow to the same text by reading). A handler is AgentPulse's
# when its "command" contains BOTH /api/v1/hooks?event= and X-Agent-Type; every
# other handler, event and top-level key stays where it is, in the same order.
# Duplicate keys in the existing file keep only the last one, in every copy.
# Returns a hashtable: Status is "changed" (Text is the file to write),
# "unchanged", or "unusable" (Reason says why; the file must be left alone).
#
# Other tools' bytes are never altered. ConvertFrom-Json changes some values
# (ISO-date strings become DateTime, large or fractional numbers are re-typed,
# ConvertTo-Json truncates past its depth), so before anything is written the
# parsed file is serialised again and compared, through one JSON writer
# (System.Text.Json), with the original text; any difference at all makes the file
# unusable. Objects are ordinal-comparer ordered dictionaries, so "Stop" and
# "stop", or "command" and "Command", never collapse.
# Never executed on Windows by anything in this change.
function ConvertTo-ApOrdered {
  param([AllowNull()]$Value)
  if ($Value -is [System.Management.Automation.PSCustomObject]) {
    $o = [System.Collections.Specialized.OrderedDictionary]::new([System.StringComparer]::Ordinal)
    foreach ($p in $Value.PSObject.Properties) { $o[$p.Name] = ConvertTo-ApOrdered $p.Value }
    return $o
  }
  if ($Value -is [System.Collections.IList]) {
    $items = New-Object System.Collections.ArrayList
    foreach ($i in $Value) { [void]$items.Add((ConvertTo-ApOrdered $i)) }
    return ,($items.ToArray())
  }
  return $Value
}

function Get-ApCanonicalJson {
  param([string]$Text)
  try { return [System.Text.Json.Nodes.JsonNode]::Parse($Text).ToJsonString() } catch { return $null }
}

function Test-ApAgentPulseHandler {
  param([AllowNull()]$Handler)
  return ($Handler -is [System.Collections.IDictionary]) -and $Handler.Contains('command') -and ($Handler['command'] -is [string]) -and $Handler['command'].Contains('/api/v1/hooks?event=') -and $Handler['command'].Contains('X-Agent-Type')
}

function Merge-ApCodexHooksFile {
  param(
    [AllowNull()][string]$Existing,
    [Parameter(Mandatory = $true)][string]$Ours
  )
  if ($null -eq $Existing -or $Existing.Trim() -eq '') {
    return @{ Status = 'changed'; Text = $Ours }
  }
  $oursHooks = (ConvertTo-ApOrdered (ConvertFrom-Json $Ours))['hooks']
  try {
    $doc = ConvertTo-ApOrdered (ConvertFrom-Json $Existing)
  } catch {
    return @{ Status = 'unusable'; Reason = 'is not valid JSON' }
  }
  if ($doc -isnot [System.Collections.Specialized.OrderedDictionary]) {
    return @{ Status = 'unusable'; Reason = 'is not a JSON object' }
  }
  if ($doc.Contains('hooks') -and ($doc['hooks'] -isnot [System.Collections.Specialized.OrderedDictionary])) {
    return @{ Status = 'unusable'; Reason = 'has a "hooks" entry that is not an object' }
  }
  $before = ConvertTo-ApHooksJson -Data $doc
  $canonicalExisting = Get-ApCanonicalJson -Text $Existing
  if ($null -eq $canonicalExisting -or $canonicalExisting -cne (Get-ApCanonicalJson -Text $before)) {
    return @{ Status = 'unusable'; Reason = 'has content that cannot be kept exactly as written' }
  }
  $hooks = [System.Collections.Specialized.OrderedDictionary]::new([System.StringComparer]::Ordinal)
  if ($doc.Contains('hooks')) {
    foreach ($k in @($doc['hooks'].Keys)) { $hooks[$k] = $doc['hooks'][$k] }
  }
  foreach ($event in @($oursHooks.Keys)) {
    if ($hooks.Contains($event) -and ($hooks[$event] -isnot [System.Array])) {
      return @{ Status = 'unusable'; Reason = "has a non-list `"$event`" entry" }
    }
  }
  foreach ($event in @($hooks.Keys)) {
    $groups = $hooks[$event]
    if ($groups -isnot [System.Array]) { continue }
    $kept = New-Object System.Collections.ArrayList
    $slot = -1
    foreach ($g in $groups) {
      $handlers = $null
      if ($g -is [System.Collections.IDictionary] -and $g.Contains('hooks')) { $handlers = $g['hooks'] }
      $hasOurs = $false
      if ($handlers -is [System.Array]) {
        foreach ($h in $handlers) { if (Test-ApAgentPulseHandler -Handler $h) { $hasOurs = $true } }
      }
      if (-not $hasOurs) { [void]$kept.Add($g); continue }
      if ($slot -eq -1) { $slot = $kept.Count }
      $rest = @($handlers | Where-Object { -not (Test-ApAgentPulseHandler -Handler $_) })
      if ($rest.Count -gt 0) {
        $g2 = [System.Collections.Specialized.OrderedDictionary]::new([System.StringComparer]::Ordinal)
        foreach ($k in @($g.Keys)) { $g2[$k] = $g[$k] }
        $g2['hooks'] = $rest
        [void]$kept.Add($g2)
      }
    }
    $pos = if ($slot -eq -1) { $kept.Count } else { $slot }
    if ($oursHooks.Contains($event)) {
      $kept.InsertRange($pos, [object[]]$oursHooks[$event])
    }
    if ($kept.Count -gt 0 -or $slot -eq -1) { $hooks[$event] = $kept.ToArray() } else { $hooks.Remove($event) }
  }
  foreach ($event in @($oursHooks.Keys)) {
    if (-not $hooks.Contains($event)) { $hooks[$event] = $oursHooks[$event] }
  }
  $doc['hooks'] = $hooks
  $after = ConvertTo-ApHooksJson -Data $doc
  if ($after -ceq $before) { return @{ Status = 'unchanged' } }
  return @{ Status = 'changed'; Text = $after }
}

# The POSIX `sh` equivalent of New-ApHookCommand, built natively in PowerShell
# (never shells out to bash) from the generator's template — Copilot's
# agentpulse.json carries both a `bash` and a `powershell` handler per event, and
# this builds the former. Copilot only: no Codex marker here (compare
# buildBashHookCommand's `agent === "codex_cli"` check).
function New-ApCopilotBashHookCommand {
  param(
    [Parameter(Mandatory = $true)][string]$BaseUrl,
    [Parameter(Mandatory = $true)][bool]$Direct,
    [Parameter(Mandatory = $true)][string]$EventName
  )
  $curl = "curl -sS --max-time 2 -o /dev/null -X POST '$BaseUrl/api/v1/hooks?event=$EventName' -H 'Content-Type: application/json' -H 'X-Agent-Type: copilot_cli'"
  $withHeader = "$curl" + " -H `"@`$f`" --data-binary `"@`$t`""
  $withoutHeader = "$curl --data-binary `"@`$t`""
  $send = if ($Direct) {
    "f=`"`$HOME/.agentpulse/hook-auth-header`"; if [ -s `"`$f`" ]; then $withHeader; else $withoutHeader; fi"
  } else {
    "$withoutHeader"
  }
  $command = $script:ApShCommandTemplate
  $command = $command.Replace('@@AP_MARKER@@', '')
  $command = $command.Replace('@@AP_GATE@@', $script:ApShGatePiece)
  $command = $command.Replace('@@AP_SEND@@', $send)
  return $command
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
  return ConvertTo-ApHooksJson -Data $obj
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
  # Written through .NET with an explicit no-BOM encoding: Windows PowerShell 5.1's own UTF8
  # encoding for Set-Content adds a byte order mark, and the installed check would then
  # differ from the generated text.
  [System.IO.File]::WriteAllText($tmp, $Content, (New-Object System.Text.UTF8Encoding($false)))
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
#
# AGEN-21: both icacls calls are best-effort — a missing/
# blocked icacls (non-NTFS volume, policy restriction) must not crash the
# install over an ACL that couldn't be verified. Matches Write-ApPrivateFile
# below and private-file.ts's tightenWindowsAclBestEffort on the TS side. A
# failure is not silent, though: see Write-ApAclWarning.
function New-ApHookAuthHeaderFile {
  param([Parameter(Mandatory = $true)][string]$ApiKey)
  $d = Join-Path $HOME ".agentpulse"
  if (Test-ApReparsePoint -Path $d) {
    throw "refusing to write through a reparse point: $d"
  }
  New-Item -ItemType Directory -Force -Path $d | Out-Null
  try {
    $icaclsOutput = icacls $d /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "icacls exited with code ${LASTEXITCODE}: $($icaclsOutput -join ' ')"
    }
  } catch {
    Write-ApAclWarning -Path $d -Detail $_.Exception.Message
  }
  $f = Join-Path $d "hook-auth-header"
  if (Test-ApMultipleHardLinks -Path $f) {
    throw "refusing to write through a multiply-linked file: $f"
  }
  if (Test-ApReparsePoint -Path $f) {
    throw "refusing to write through a reparse point: $f"
  }
  Set-Content -NoNewline -Path $f -Value "Authorization: Bearer $ApiKey`n" -Encoding UTF8
  try {
    $icaclsOutput = icacls $f /inheritance:r /grant:r "$($env:USERNAME):(R,W)" 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "icacls exited with code ${LASTEXITCODE}: $($icaclsOutput -join ' ')"
    }
  } catch {
    Write-ApAclWarning -Path $f -Detail $_.Exception.Message
  }
}

# The shell check as written to disk: the placeholders become the real tab,
# carriage return and byte order mark, then any CRLF a checkout introduced is
# normalised to LF (the script must be LF-only for sh).
function Get-ApExcludeBashScriptText {
  return ($script:ApExcludeBashScript + "`n").Replace('@@AP_TAB@@', [string][char]9).Replace('@@AP_CR@@', [string][char]13).Replace('@@AP_BOM@@', [string][char]0xFEFF).Replace("`r`n", "`n")
}

# Installs (or refreshes) ~/.agentpulse/exclude-check.sh and exclude-check.ps1,
# the checks every hook command runs when a rules file exists. Written through
# Write-ApFileNoFollow (temp file, atomic move, never through a reparse point). A
# directory that is a link, or a target that can't be written, prints a warning and
# installs nothing: the hooks still send as before until a rules file exists, and
# with one present they send nothing until the checks are installed. Never executed
# on Windows by anything in this change.
function Install-ApExcludeScripts {
  $dir = Join-Path $HOME ".agentpulse"
  if (Test-ApReparsePoint -Path $dir) {
    Write-Host "! Exclusion check not installed: $dir is a link; remove it and run this again."
    return
  }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $files = @(
    @{ Path = (Join-Path $dir "exclude-check.sh"); Content = (Get-ApExcludeBashScriptText) },
    @{ Path = (Join-Path $dir "exclude-check.ps1"); Content = ($script:ApExcludePsScript + "`n") }
  )
  foreach ($file in $files) {
    try {
      Write-ApFileNoFollow -Path $file.Path -Content $file.Content
      if ([System.IO.File]::ReadAllText($file.Path, (New-Object System.Text.UTF8Encoding($false))) -ne $file.Content) {
        Remove-Item -LiteralPath $file.Path -Force -ErrorAction SilentlyContinue
        Write-Host "! Exclusion check not installed: what was written to $($file.Path) could not be verified; run this again."
        return
      }
    } catch {
      Write-Host "! Exclusion check not installed: $($_.Exception.Message)"
      return
    }
  }
  Write-Step "Exclusion check installed: $dir"
}
# <<< agentpulse-hook-cmd

# Narrowing an ACL is best-effort (restricted and non-NTFS volumes), but a
# failure must never be silent: until it is fixed, other local users may be
# able to read what was just written there.
function Write-ApAclWarning {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Detail
  )
  Write-Warning "Could not restrict access to $Path ($Detail). Other local users may be able to read the API key or credentials stored there."
}

# AGEN-21 (security, Medium): .env.local and supervisor.json both hold
# secrets in plaintext (AGENTPULSE_INITIAL_API_KEY, and the supervisor
# credential/enrollment token respectively) and were previously written via
# plain Set-Content/Set-JsonFile — no reparse-point guard, and node's/
# PowerShell's mode bits don't narrow the ACL other local Windows accounts
# hold on the file. Write-ApPrivateFile reuses Write-ApFileNoFollow (the
# same reparse-point-safe primitive as the Codex/Copilot hooks writers
# above) then narrows the ACL to the current user only, mirroring
# New-ApHookAuthHeaderFile's `icacls ... /inheritance:r /grant:r
# "user:(R,W)"`. Kept outside the agentpulse-hook-cmd marker block above:
# it isn't part of the cross-file hook-install parity that block tracks.
#
# AGEN-21 (xander, High): narrows the parent directory's ACL *before*
# Write-ApFileNoFollow creates the file inside it — same F208 ordering as
# New-ApHookAuthHeaderFile. Directory-then-file (the prior shape) left a
# window where a freshly-created file briefly held the directory's
# broader, inherited ACL before the file-level icacls call narrowed it.
# Every icacls call is best-effort: a missing/blocked icacls (non-NTFS
# volume, policy restriction) must not fail the install over an ACL that
# couldn't be verified — matches Test-ApMultipleHardLinks's precedent and
# private-file.ts's tightenWindowsAclBestEffort on the TS side.
function Write-ApPrivateFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )
  $dir = Split-Path -Parent $Path
  if (Test-ApReparsePoint -Path $dir) {
    throw "refusing to write into a reparse-point directory: $dir"
  }
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  try {
    $icaclsOutput = icacls $dir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "icacls exited with code ${LASTEXITCODE}: $($icaclsOutput -join ' ')"
    }
  } catch {
    Write-ApAclWarning -Path $dir -Detail $_.Exception.Message
  }
  Write-ApFileNoFollow -Path $Path -Content $Content
  try {
    $icaclsOutput = icacls $Path /inheritance:r /grant:r "$($env:USERNAME):(R,W)" 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "icacls exited with code ${LASTEXITCODE}: $($icaclsOutput -join ' ')"
    }
  } catch {
    Write-ApAclWarning -Path $Path -Detail $_.Exception.Message
  }
}

function Write-ApPrivateJsonFile {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$Data
  )
  Write-ApPrivateFile -Path $Path -Content ($Data | ConvertTo-Json -Depth 20)
}

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
  $hookHeadersClaude = @{ "X-Agent-Type" = "claude_code"; "X-AgentPulse-Skip" = '$AGENTPULSE_SKIP' }
  if ($ApiKey) {
    $hookHeadersClaude["Authorization"] = "Bearer $ApiKey"
  }
  # Claude Code expands a header variable only for names listed in
  # allowedEnvVars, so the skip variable is listed in every form.
  $allowedEnvVars = @("AGENTPULSE_SKIP")
  if (-not $ApiKey) { $allowedEnvVars = @("AGENTPULSE_API_KEY", "AGENTPULSE_SKIP") }

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
    $hook.hooks[0]["allowedEnvVars"] = $allowedEnvVars
    $claudeData["hooks"][$eventName] = @($hook)
  }
  Set-JsonFile -Path $claudeSettings -Data $claudeData
  if ($ApiKey) {
    # H2: a literal key is embedded above, so settings.json is narrowed to
    # a single ACE for the current user — never inherited/broadly readable.
    # AGEN-21 (xander, Medium): best-effort, matching every other icacls
    # call site — a missing/blocked icacls must not crash the install.
    try {
      $icaclsOutput = icacls $claudeSettings /inheritance:r /grant:r "$($env:USERNAME):(R,W)" 2>&1
      if ($LASTEXITCODE -ne 0) {
        throw "icacls exited with code ${LASTEXITCODE}: $($icaclsOutput -join ' ')"
      }
    } catch {
      Write-ApAclWarning -Path $claudeSettings -Detail $_.Exception.Message
    }
  }

  # D12 (r6, Phase 0 fact 5): Codex 0.145 loads hooks only from
  # $CODEX_HOME/hooks.json — a project-level .codex/hooks.json is never read.
  $codexDir = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME ".codex" }
  Ensure-Dir $codexDir
  $codexHooksFile = Join-Path $codexDir "hooks.json"

  if ($ApiKey) {
    New-ApHookAuthHeaderFile -ApiKey $ApiKey
  }
  Install-ApExcludeScripts

  $newCodexHooksJson = New-ApCodexHooksFile -BaseUrl $PublicUrl -Direct $true
  $existingCodexHooksJson = $null
  $codexReadFailed = $false
  if (Test-Path $codexHooksFile) {
    try {
      $existingCodexHooksJson = Get-Content $codexHooksFile -Raw -ErrorAction Stop
      if ($null -eq $existingCodexHooksJson) { $existingCodexHooksJson = "" }
    } catch {
      $codexReadFailed = $true
    }
  }
  $codexSkipTail = "It was left untouched. To add the AgentPulse hooks, fix or move that file and run this installer again."
  if ($codexReadFailed) {
    $codexMerge = @{ Status = "unreadable" }
  } else {
    $codexMerge = Merge-ApCodexHooksFile -Existing $existingCodexHooksJson -Ours $newCodexHooksJson
  }
  if ($codexMerge.Status -eq "unchanged") {
    Write-Step "Codex hooks unchanged — no re-trust needed"
  } elseif (Test-ApReparsePoint -Path $codexHooksFile) {
    throw "refusing to write through a reparse point: $codexHooksFile"
  } elseif ($codexMerge.Status -eq "unreadable") {
    Write-Host "! Codex hooks not updated: $codexHooksFile could not be read. $codexSkipTail"
  } elseif ($codexMerge.Status -eq "unusable") {
    Write-Host "! Codex hooks not updated: $codexHooksFile $($codexMerge.Reason). $codexSkipTail"
  } else {
    $codexBackupFile = $null
    try {
      if ($null -ne $existingCodexHooksJson) {
        $codexBackupFile = "$codexHooksFile.agentpulse-bak.$(Get-Date -AsUTC -Format 'yyyyMMddTHHmmssZ')"
        Write-ApFileNoFollow -Path $codexBackupFile -Content $existingCodexHooksJson
      }
      Write-ApFileNoFollow -Path $codexHooksFile -Content $codexMerge.Text
      $codexWritten = $true
    } catch {
      $codexWritten = $false
      if ($codexBackupFile) { Remove-Item -LiteralPath $codexBackupFile -Force -ErrorAction SilentlyContinue }
      Write-Host "! Codex hooks not updated: $codexHooksFile could not be written ($($_.Exception.Message)). $codexSkipTail"
    }
    if ($codexWritten) {
      if ($codexBackupFile) {
        $script:CodexHooksWritten = "updated"
        Write-Step "Backed up existing Codex hooks to $codexBackupFile"
      }
      Write-Step "Codex CLI hooks configured"
      Write-Step "Open Codex and run /hooks, then trust the AgentPulse hooks — Codex silently skips untrusted hooks."
      Write-Step "Re-trust after changing the AgentPulse URL or port."
      if ($script:CodexHooksWritten -ne "updated") { $script:CodexHooksWritten = "new" }
    }
  }
  Write-Step "After editing ~/.agentpulse/exclude by hand, run: agentpulse exclude check"
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
    Write-Step "After editing ~/.agentpulse/exclude by hand, run: agentpulse exclude check"
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

# AGEN-21: was a bare `Set-Content` — no reparse-point guard, and .env.local
# holds AGENTPULSE_INITIAL_API_KEY in plaintext. Write-ApPrivateFile writes
# it reparse-point-safe and ACL-narrowed to the current user only.
$envFileContent = @"
PORT=$Port
HOST=$HostName
PUBLIC_URL=$PublicUrl
DISABLE_AUTH=$DisableAuth
AGENTPULSE_INITIAL_API_KEY=$ApiKey
DATA_DIR=$DataDir
SQLITE_PATH=$DataDir\agentpulse.db
NODE_ENV=production
"@
Write-ApPrivateFile -Path $EnvFile -Content $envFileContent
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
    # AGEN-21: was Set-JsonFile (plain Set-Content, no reparse-point guard,
    # no ACL narrowing) — supervisor.json holds the supervisor credential /
    # enrollment token in plaintext.
    Write-ApPrivateJsonFile -Path $SupervisorConfigPath -Data $supervisorConfig
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
if ($script:CodexHooksWritten -eq "new") {
  Write-Host ""
  Write-Step "Codex needs you to approve these hooks: run /hooks in Codex."
} elseif ($script:CodexHooksWritten -eq "updated") {
  Write-Host ""
  Write-Step "Codex: open /hooks and approve the updated AgentPulse hooks again; the hook command changed, so Codex asks once more."
}
