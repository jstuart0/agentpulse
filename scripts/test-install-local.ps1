# Phase 5 (D12/D13): real PowerShell execution coverage for install-local.ps1's
# hook-command generators, run by the "Windows Installer Validation" CI job
# (windows-latest, real pwsh — this file is NOT parsed/executed anywhere in
# the primary dev/CI environment, which has no pwsh; see
# scripts/hook-command-parity.test.ts's static-comparison note).
#
# Dot-sources install-local.ps1 -FunctionsOnly (never runs the installer's
# main flow), then exercises New-ApHookAuthHeaderFile, New-ApHookCommand and
# New-ApCodexHooksFile against a real HttpListener and the checked-in golden.

$ErrorActionPreference = "Stop"
$failures = 0

function Assert-True($condition, $message) {
	if (-not $condition) {
		Write-Error "FAIL: $message"
		$script:failures++
	} else {
		Write-Host "ok: $message"
	}
}

$tempProfile = Join-Path ([System.IO.Path]::GetTempPath()) ("ap-test-install-local-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempProfile | Out-Null
$env:USERPROFILE = $tempProfile
$env:HOME = $tempProfile

$installer = Resolve-Path (Join-Path $PSScriptRoot "install-local.ps1")
. $installer -FunctionsOnly

# ── New-ApHookAuthHeaderFile: single-ACE ACL ──
New-ApHookAuthHeaderFile -ApiKey "ap_test_key_123"
$headerFile = Join-Path $HOME ".agentpulse\hook-auth-header"
Assert-True (Test-Path $headerFile) "hook-auth-header file exists"
$content = Get-Content $headerFile -Raw
Assert-True ($content -eq "Authorization: Bearer ap_test_key_123`n") "hook-auth-header content matches"
$acl = Get-Acl $headerFile
Assert-True ($acl.Access.Count -eq 1) "hook-auth-header has exactly one ACE (found $($acl.Access.Count))"
# F208: the parent directory's ACL must be narrowed too, and narrowed
# *before* the file was created inside it (see New-ApHookAuthHeaderFile) —
# a broad, inherited directory ACL would have let the file inherit it for
# the brief window between Set-Content and the file's own icacls call.
$dirAcl = Get-Acl (Join-Path $HOME ".agentpulse")
Assert-True ($dirAcl.Access.Count -eq 1) ".agentpulse dir has exactly one ACE (found $($dirAcl.Access.Count))"

# ── AGEN-49: Configure-Hooks never writes a literal key into settings.json,
# even when $ApiKey is set — settings.json has no ACL narrowing applied to
# it (unlike hook-auth-header above), so a literal key there would be a
# world-readable secret. Always the $env:AGENTPULSE_API_KEY expansion form.
$ApiKey = "ap_test_key_123"
Configure-Hooks
$claudeSettingsPath = Join-Path $HOME ".claude\settings.json"
Assert-True (Test-Path $claudeSettingsPath) "Configure-Hooks: settings.json written"
$claudeSettingsContent = Get-Content $claudeSettingsPath -Raw
Assert-True ($claudeSettingsContent.Contains('$env:AGENTPULSE_API_KEY')) "Configure-Hooks: settings.json references `$env:AGENTPULSE_API_KEY, not a literal key"
Assert-True (-not $claudeSettingsContent.Contains("ap_test_key_123")) "Configure-Hooks: settings.json never contains the literal key value, even though `$ApiKey was set"
Assert-True ($claudeSettingsContent.Contains('"allowedEnvVars"')) "Configure-Hooks: settings.json declares allowedEnvVars for Claude Code's env-var expansion"

# ── New-ApHookCommand: real execution against a real HttpListener ──
# .NET's native async pattern (BeginGetContext/EndGetContext) rather than a
# background Job — HttpListener objects don't marshal across PowerShell
# runspaces, so a Job-based listener would need its own separate listener
# instance and a second port-coordination step for no benefit.
$port = Get-Random -Minimum 20000 -Maximum 40000
$baseUrl = "http://127.0.0.1:$port"
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("$baseUrl/")
$listener.Start()
$asyncResult = $listener.BeginGetContext($null, $null)

$cmd = New-ApHookCommand -BaseUrl $baseUrl -Direct $true -AgentType "codex_cli" -EventName "Stop"
$scriptFile = Join-Path $tempProfile "hook-cmd.ps1"
Set-Content -Path $scriptFile -Value $cmd -Encoding UTF8

$fixture = '{"session_id":"pwsh-test-session","hook_event_name":"Stop"}'
$fixture | powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptFile

$captured = $null
if ($asyncResult.AsyncWaitHandle.WaitOne(10000)) {
	$ctx = $listener.EndGetContext($asyncResult)
	$reader = New-Object System.IO.StreamReader($ctx.Request.InputStream)
	$captured = [pscustomobject]@{
		Path          = $ctx.Request.Url.AbsolutePath
		Query         = $ctx.Request.Url.Query
		AgentType     = $ctx.Request.Headers["X-Agent-Type"]
		Authorization = $ctx.Request.Headers["Authorization"]
		Body          = $reader.ReadToEnd()
	}
	$ctx.Response.StatusCode = 200
	$ctx.Response.Close()
}
$listener.Stop()

Assert-True ($null -ne $captured) "the generated command delivered a request to the listener"
if ($null -ne $captured) {
	Assert-True ($captured.Path -eq "/api/v1/hooks") "request path is /api/v1/hooks"
	Assert-True ($captured.Query -eq "?event=Stop") "request query is ?event=Stop"
	Assert-True ($captured.AgentType -eq "codex_cli") "X-Agent-Type header is codex_cli"
	Assert-True ($captured.Authorization -eq "Bearer ap_test_key_123") "Authorization header present with the saved key"
	Assert-True ($captured.Body -eq $fixture) "body arrives byte-exact"
}

# ── F217: the D19 native-coverage marker sid gate, executed for real ──
# The marker check/write in New-ApHookCommand's generated script runs
# synchronously, before the async Start-Job that does the network call — so
# by the time `powershell.exe -File $scriptFile` (piped a payload on stdin)
# exits, the marker gate has already decided. No listener/wait needed here.
function Test-ApMarkerCase($payloadJson) {
	$markerDir = Join-Path $HOME ".agentpulse\codex-native"
	Remove-Item -Recurse -Force $markerDir -ErrorAction SilentlyContinue
	$cmd = New-ApHookCommand -BaseUrl $baseUrl -Direct $true -AgentType "codex_cli" -EventName "Stop"
	$scriptFile2 = Join-Path $tempProfile "hook-cmd-marker.ps1"
	Set-Content -Path $scriptFile2 -Value $cmd -Encoding UTF8
	$payloadJson | powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptFile2
	$entries = @()
	if (Test-Path $markerDir) { $entries = @(Get-ChildItem $markerDir) }
	return $entries
}

$validSid = "pwsh-marker-valid-abc123"
$entries = Test-ApMarkerCase "{`"session_id`":`"$validSid`"}"
Assert-True ($entries.Count -eq 1 -and $entries[0].Name -eq $validSid) "a valid sid writes exactly the expected marker"

$entries = Test-ApMarkerCase '{"session_id":"abc/def"}'
Assert-True ($entries.Count -eq 0) "a sid containing '/' leaves no marker file"

$entries = Test-ApMarkerCase '{"session_id":"../../etc/passwd"}'
Assert-True ($entries.Count -eq 0) "a sid containing '..' leaves no marker file"

$tooLongSid = "a" * 129
$entries = Test-ApMarkerCase "{`"session_id`":`"$tooLongSid`"}"
Assert-True ($entries.Count -eq 0) "a sid over 128 chars leaves no marker file"

$entries = Test-ApMarkerCase '{"hook_event_name":"Stop"}'
Assert-True ($entries.Count -eq 0) "a payload with no session_id field leaves no marker file"

# ── Authorization absent when hook-auth-header is missing/empty ──
Remove-Item -Force $headerFile -ErrorAction SilentlyContinue
$cmdNoAuth = New-ApHookCommand -BaseUrl $baseUrl -Direct $true -AgentType "codex_cli" -EventName "SessionStart"
Assert-True ($cmdNoAuth.Length -gt 0) "command still generates without a key file present"

# ── New-ApCodexHooksFile: deep-equals the checked-in golden ──
$golden = Get-Content (Resolve-Path (Join-Path $PSScriptRoot "__golden__/codex-hooks.direct.json")) -Raw | ConvertFrom-Json
$generated = New-ApCodexHooksFile -BaseUrl "http://localhost:3000" -Direct $true | ConvertFrom-Json

$goldenEvents = $golden.hooks.PSObject.Properties.Name | Sort-Object
$generatedEvents = $generated.hooks.PSObject.Properties.Name | Sort-Object
Assert-True (($goldenEvents -join ",") -eq ($generatedEvents -join ",")) "event set matches the golden (12 events)"

foreach ($event in $goldenEvents) {
	$g = $golden.hooks.$event[0].hooks[0]
	$n = $generated.hooks.$event[0].hooks[0]
	Assert-True ($g.type -eq $n.type) "$event`: type matches ($($n.type))"
	Assert-True ($g.async -eq $n.async) "$event`: async matches ($($n.async))"
	Assert-True ($g.timeout -eq $n.timeout) "$event`: timeout matches ($($n.timeout))"
	Assert-True ($g.command -eq $n.command) "$event`: command matches the golden byte-for-byte"
}

# ── Phase 7 (D7/D8/D13): Copilot hooks — real execution + structural check ──
$copilotExpectedEvents = @(
	"sessionStart","sessionEnd","userPromptSubmitted","postToolUse","postToolUseFailure",
	"agentStop","subagentStart","subagentStop","preCompact","errorOccurred"
) | Sort-Object

$copilotGenerated = New-ApCopilotHooksFile -BaseUrl "http://localhost:3000" -Direct $true | ConvertFrom-Json
Assert-True ($copilotGenerated.version -eq 1) "New-ApCopilotHooksFile: version is 1"
$copilotGeneratedEvents = $copilotGenerated.hooks.PSObject.Properties.Name | Sort-Object
Assert-True (($copilotExpectedEvents -join ",") -eq ($copilotGeneratedEvents -join ",")) "New-ApCopilotHooksFile: event set matches D7's registered 10 (found $($copilotGeneratedEvents -join ','))"
Assert-True (-not ($copilotGeneratedEvents -contains "preToolUse")) "New-ApCopilotHooksFile: preToolUse is excluded"
Assert-True (-not ($copilotGeneratedEvents -contains "permissionRequest")) "New-ApCopilotHooksFile: permissionRequest is excluded"

foreach ($event in $copilotGeneratedEvents) {
	$handler = $copilotGenerated.hooks.$event[0]
	Assert-True ($handler.type -eq "command") "$event (Copilot): type is command"
	Assert-True ($handler.timeoutSec -eq 5) "$event (Copilot): timeoutSec is 5"
	Assert-True ($handler.bash -is [string] -and $handler.bash.Length -gt 0) "$event (Copilot): bash handler is a non-empty string"
	Assert-True ($handler.powershell -is [string] -and $handler.powershell.Length -gt 0) "$event (Copilot): powershell handler is a non-empty string"
	Assert-True ($handler.bash.Contains("?event=$event")) "$event (Copilot): bash command targets its own event"
	Assert-True ($handler.bash.Contains("X-Agent-Type: copilot_cli")) "$event (Copilot): bash command carries X-Agent-Type: copilot_cli"
}

# Real execution of the PowerShell handler for one event (mirrors the
# New-ApHookCommand/Codex HttpListener test above) — proves
# New-ApCopilotBashHookCommand's sibling powershell field, generated via the
# same New-ApHookCommand this file already exercises, actually delivers.
$portCopilot = Get-Random -Minimum 20000 -Maximum 40000
$baseUrlCopilot = "http://127.0.0.1:$portCopilot"
$listenerCopilot = New-Object System.Net.HttpListener
$listenerCopilot.Prefixes.Add("$baseUrlCopilot/")
$listenerCopilot.Start()
$asyncResultCopilot = $listenerCopilot.BeginGetContext($null, $null)

$copilotCmd = New-ApHookCommand -BaseUrl $baseUrlCopilot -Direct $true -AgentType "copilot_cli" -EventName "sessionStart"
$copilotScriptFile = Join-Path $tempProfile "hook-cmd-copilot.ps1"
Set-Content -Path $copilotScriptFile -Value $copilotCmd -Encoding UTF8
$copilotFixture = '{"sessionId":"pwsh-copilot-session","cwd":"C:\\Users\\test\\project"}'
$copilotFixture | powershell.exe -NoProfile -ExecutionPolicy Bypass -File $copilotScriptFile

$copilotCaptured = $null
if ($asyncResultCopilot.AsyncWaitHandle.WaitOne(10000)) {
	$ctx = $listenerCopilot.EndGetContext($asyncResultCopilot)
	$reader = New-Object System.IO.StreamReader($ctx.Request.InputStream)
	$copilotCaptured = [pscustomobject]@{
		Path      = $ctx.Request.Url.AbsolutePath
		Query     = $ctx.Request.Url.Query
		AgentType = $ctx.Request.Headers["X-Agent-Type"]
		Body      = $reader.ReadToEnd()
	}
	$ctx.Response.StatusCode = 200
	$ctx.Response.Close()
}
$listenerCopilot.Stop()

Assert-True ($null -ne $copilotCaptured) "Copilot: the generated command delivered a request to the listener"
if ($null -ne $copilotCaptured) {
	Assert-True ($copilotCaptured.Path -eq "/api/v1/hooks") "Copilot: request path is /api/v1/hooks"
	Assert-True ($copilotCaptured.Query -eq "?event=sessionStart") "Copilot: request query is ?event=sessionStart"
	Assert-True ($copilotCaptured.AgentType -eq "copilot_cli") "Copilot: X-Agent-Type header is copilot_cli"
	Assert-True ($copilotCaptured.Body -eq $copilotFixture) "Copilot: body arrives byte-exact"
}

# ── F232/F233 (xander, Medium): Test-ApReparsePoint / Write-ApFileNoFollow — real execution ──
# Requires permission to create a symlink (Developer Mode, or an elevated/
# admin context — both true on GitHub's windows-latest hosted runners). If
# neither is available here, skip these assertions with a warning rather
# than failing the whole suite over an environment gap unrelated to the
# code under test.
$canSymlink = $true
$reparseProbeDir = Join-Path $tempProfile "reparse-probe"
New-Item -ItemType Directory -Force -Path $reparseProbeDir | Out-Null
$reparseProbeReal = Join-Path $reparseProbeDir "real.txt"
Set-Content -Path $reparseProbeReal -Value "probe" -Encoding UTF8
$reparseProbeLink = Join-Path $reparseProbeDir "link.txt"
try {
	New-Item -ItemType SymbolicLink -Path $reparseProbeLink -Target $reparseProbeReal -ErrorAction Stop | Out-Null
} catch {
	$canSymlink = $false
	Write-Host "warning: cannot create a symlink in this environment ($($_.Exception.Message)) — skipping F232/F233 reparse-point assertions"
}

if ($canSymlink) {
	Assert-True (Test-ApReparsePoint -Path $reparseProbeLink) "Test-ApReparsePoint: a real symlink is detected"
	Assert-True (-not (Test-ApReparsePoint -Path $reparseProbeReal)) "Test-ApReparsePoint: a plain file is not a reparse point"
	Assert-True (-not (Test-ApReparsePoint -Path (Join-Path $reparseProbeDir "does-not-exist.txt"))) "Test-ApReparsePoint: a missing path is not a reparse point (returns false, not an error)"

	# Write-ApFileNoFollow refuses a symlink at the destination — decoy untouched.
	$decoyPath = Join-Path $reparseProbeDir "decoy-hooks.json"
	Set-Content -Path $decoyPath -Value "should never change" -Encoding UTF8
	$hooksLinkPath = Join-Path $reparseProbeDir "hooks.json"
	New-Item -ItemType SymbolicLink -Path $hooksLinkPath -Target $decoyPath | Out-Null
	$threw = $false
	try {
		Write-ApFileNoFollow -Path $hooksLinkPath -Content "attacker-controlled"
	} catch {
		$threw = $true
	}
	Assert-True $threw "Write-ApFileNoFollow: a symlink at the destination throws instead of writing through it"
	Assert-True ((Get-Content $decoyPath -Raw) -eq "should never change") "Write-ApFileNoFollow: the symlink's target is untouched after the refused write"

	# Write-ApFileNoFollow refuses a symlink at a *backup* path too — same
	# primitive, a different path, matching the plan's "hooks path AND
	# backup path" requirement.
	$decoyBackupPath = Join-Path $reparseProbeDir "decoy-backup.json"
	Set-Content -Path $decoyBackupPath -Value "backup should never change" -Encoding UTF8
	$backupLinkPath = Join-Path $reparseProbeDir "hooks.json.agentpulse-bak.20260929T000000Z"
	New-Item -ItemType SymbolicLink -Path $backupLinkPath -Target $decoyBackupPath | Out-Null
	$backupThrew = $false
	try {
		Write-ApFileNoFollow -Path $backupLinkPath -Content "attacker-controlled backup"
	} catch {
		$backupThrew = $true
	}
	Assert-True $backupThrew "Write-ApFileNoFollow: a symlink at the backup path throws instead of writing through it"
	Assert-True ((Get-Content $decoyBackupPath -Raw) -eq "backup should never change") "Write-ApFileNoFollow: the backup symlink's target is untouched after the refused write"

	# A normal (non-reparse-point) write still succeeds.
	$normalPath = Join-Path $reparseProbeDir "normal-hooks.json"
	Write-ApFileNoFollow -Path $normalPath -Content '{"hooks":{}}'
	Assert-True ((Get-Content $normalPath -Raw) -eq '{"hooks":{}}') "Write-ApFileNoFollow: a normal write to a non-reparse-point path succeeds"

	# F233: New-ApHookAuthHeaderFile itself refuses a symlinked hook-auth-header.
	$authProbeHome = Join-Path $tempProfile "auth-reparse-probe"
	New-Item -ItemType Directory -Force -Path $authProbeHome | Out-Null
	$savedHome = $env:USERPROFILE
	$env:USERPROFILE = $authProbeHome
	$env:HOME = $authProbeHome
	$agentpulseDir = Join-Path $authProbeHome ".agentpulse"
	New-Item -ItemType Directory -Force -Path $agentpulseDir | Out-Null
	$authDecoyPath = Join-Path $authProbeHome "decoy-auth-header"
	Set-Content -Path $authDecoyPath -Value "should never change" -Encoding UTF8
	$authHeaderLinkPath = Join-Path $agentpulseDir "hook-auth-header"
	New-Item -ItemType SymbolicLink -Path $authHeaderLinkPath -Target $authDecoyPath | Out-Null
	$authThrew = $false
	try {
		New-ApHookAuthHeaderFile -ApiKey "ap_attacker_controlled"
	} catch {
		$authThrew = $true
	}
	Assert-True $authThrew "New-ApHookAuthHeaderFile (F233): a symlinked hook-auth-header throws instead of writing through it"
	Assert-True ((Get-Content $authDecoyPath -Raw) -eq "should never change") "New-ApHookAuthHeaderFile (F233): the symlink's target is untouched after the refused write"
	$env:USERPROFILE = $savedHome
	$env:HOME = $savedHome
}

# ── F242 (xander, re-verify): Test-ApMultipleHardLinks — real execution ──
# Hard links (unlike symlinks) need no Developer Mode/elevation on NTFS —
# `New-Item -ItemType HardLink` is a plain user operation — so this runs
# unconditionally rather than behind $canSymlink.
$hardlinkProbeDir = Join-Path $tempProfile "hardlink-probe"
New-Item -ItemType Directory -Force -Path $hardlinkProbeDir | Out-Null
$hardlinkOriginal = Join-Path $hardlinkProbeDir "hooks.json"
Set-Content -Path $hardlinkOriginal -Value "should never change" -Encoding UTF8
$canHardlink = $true
try {
	$hardlinkAlias = Join-Path $hardlinkProbeDir "hooks-alias.json"
	New-Item -ItemType HardLink -Path $hardlinkAlias -Target $hardlinkOriginal -ErrorAction Stop | Out-Null
} catch {
	$canHardlink = $false
	Write-Host "warning: cannot create a hard link in this environment ($($_.Exception.Message)) — skipping F242 hardlink assertions"
}

if ($canHardlink) {
	Assert-True (Test-ApMultipleHardLinks -Path $hardlinkOriginal) "Test-ApMultipleHardLinks: detects a file with more than one hard link"
	Assert-True (-not (Test-ApMultipleHardLinks -Path (Join-Path $hardlinkProbeDir "single-link.json"))) "Test-ApMultipleHardLinks: a nonexistent path is not multiply-linked (fails open, returns false)"

	$singleLinkPath = Join-Path $hardlinkProbeDir "single-link.json"
	Set-Content -Path $singleLinkPath -Value "only one link" -Encoding UTF8
	Assert-True (-not (Test-ApMultipleHardLinks -Path $singleLinkPath)) "Test-ApMultipleHardLinks: a plain single-link file is not flagged"

	# Write-ApFileNoFollow refuses a multiply-linked destination — the
	# original data (reachable via either directory entry) is untouched.
	$hardlinkThrew = $false
	try {
		Write-ApFileNoFollow -Path $hardlinkAlias -Content "attacker-controlled via hardlink"
	} catch {
		$hardlinkThrew = $true
	}
	Assert-True $hardlinkThrew "Write-ApFileNoFollow (F242): a multiply-linked destination throws instead of writing through it"
	Assert-True ((Get-Content $hardlinkOriginal -Raw) -eq "should never change") "Write-ApFileNoFollow (F242): the hard-linked data is untouched after the refused write"

	# New-ApHookAuthHeaderFile itself refuses a multiply-linked hook-auth-header.
	$hardlinkAuthHome = Join-Path $tempProfile "auth-hardlink-probe"
	New-Item -ItemType Directory -Force -Path $hardlinkAuthHome | Out-Null
	$savedHomeHardlink = $env:USERPROFILE
	$env:USERPROFILE = $hardlinkAuthHome
	$env:HOME = $hardlinkAuthHome
	$agentpulseDirHardlink = Join-Path $hardlinkAuthHome ".agentpulse"
	New-Item -ItemType Directory -Force -Path $agentpulseDirHardlink | Out-Null
	$authHeaderTarget = Join-Path $hardlinkAuthHome "decoy-auth-header"
	Set-Content -Path $authHeaderTarget -Value "should never change" -Encoding UTF8
	$authHeaderHardlinkPath = Join-Path $agentpulseDirHardlink "hook-auth-header"
	New-Item -ItemType HardLink -Path $authHeaderHardlinkPath -Target $authHeaderTarget | Out-Null
	$authHardlinkThrew = $false
	try {
		New-ApHookAuthHeaderFile -ApiKey "ap_attacker_controlled_via_hardlink"
	} catch {
		$authHardlinkThrew = $true
	}
	Assert-True $authHardlinkThrew "New-ApHookAuthHeaderFile (F242): a multiply-linked hook-auth-header throws instead of writing through it"
	Assert-True ((Get-Content $authHeaderTarget -Raw) -eq "should never change") "New-ApHookAuthHeaderFile (F242): the hard-linked target is untouched after the refused write"
	$env:USERPROFILE = $savedHomeHardlink
	$env:HOME = $savedHomeHardlink
}

Remove-Item -Recurse -Force $tempProfile -ErrorAction SilentlyContinue

if ($failures -gt 0) {
	Write-Error "$failures assertion(s) failed"
	exit 1
}
Write-Host "All install-local.ps1 hook-command assertions passed."
exit 0
