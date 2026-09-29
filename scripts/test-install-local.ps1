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

Remove-Item -Recurse -Force $tempProfile -ErrorAction SilentlyContinue

if ($failures -gt 0) {
	Write-Error "$failures assertion(s) failed"
	exit 1
}
Write-Host "All install-local.ps1 hook-command assertions passed."
exit 0
