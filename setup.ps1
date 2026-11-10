#!/usr/bin/env pwsh
# magpie-agent-trae-bridge — one-shot setup for Trae CN / Trae (Windows PowerShell)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error 'Node.js 20+ is required but "node" was not found in PATH.'
}

$installArgs = @()
if ($args.Count -gt 0) { $installArgs = $args }

& node (Join-Path $here 'bin\trae-magpie.js') install @installArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host ''
Write-Host 'done. Restart Trae to load the Magpie model catalog.' -ForegroundColor Green
Write-Host 'check:  node bin\trae-magpie.js doctor'
Write-Host 'revert: node bin\trae-magpie.js uninstall'
