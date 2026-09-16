# Compatibility entrypoint. Historical trial code is preserved in archive/20260905-installer-helper-preparation/legacy-entrypoints/.
[CmdletBinding()]
param(
    [string]$MsiPath,
    [string]$EvidenceDirectory,
    [string]$RequestPath,
    [switch]$PrepareOnly,
    [switch]$NoElevate
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'DESKTOP/scripts/install-current-msi.ps1') @PSBoundParameters