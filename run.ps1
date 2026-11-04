# Otto's long-lived session on Windows: the counterpart of run.sh.
#
# Run it in a real console (a Task Scheduler task at logon, minimized). Windows has
# no `script`, and a console gives claude the interactive terminal the channel needs.
$ErrorActionPreference = "Stop"

$OttoHome = $PSScriptRoot
$env:OTTO_HOME = $OttoHome
$env:Path = "$env:USERPROFILE\.local\bin;$env:USERPROFILE\.bun\bin;$env:Path"

# Tells server.ts this session receives the channel and may take the Telegram token.
# Without it the server stays tools-only even under --channels (seen on Windows, 4 Nov 2026).
$env:OTTO_CHANNEL_HOST = "1"

$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude) { $claude = "$env:USERPROFILE\.local\bin\claude.exe" }
if (-not (Test-Path $claude)) { Write-Error "otto: claude not found (looked in PATH and in $env:USERPROFILE\.local\bin)" }

# The cwd cannot be the marketplace root; runtime\ still inherits the CLAUDE.md files above it.
$run = Join-Path $OttoHome "runtime"
New-Item -ItemType Directory -Force $run | Out-Null
Set-Location $run

# --channels is variadic: keep it last.
& $claude --permission-mode auto --channels plugin:otto@otto
exit $LASTEXITCODE
