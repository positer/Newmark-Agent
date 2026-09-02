$ErrorActionPreference = 'Stop'

$probeRoot = Get-ChildItem ([IO.Path]::GetTempPath()) -Directory -Filter 'newmark-slinusc-probe-*' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if (-not $probeRoot) { throw 'slinusc probe checkout not found' }

$python = Join-Path $probeRoot.FullName '.venv/Scripts/python.exe'
$stdout = Join-Path $probeRoot.FullName 'server.out'
$stderr = Join-Path $probeRoot.FullName 'server.err'
$env:SEARXNG_URL = 'https://searx.bndkt.io'
$process = Start-Process -FilePath $python -ArgumentList @('server.py') -WorkingDirectory $probeRoot.FullName `
  -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr

try {
  $ready = $false
  foreach ($attempt in 1..30) {
    try {
      Invoke-RestMethod 'http://127.0.0.1:8003/healthz' -TimeoutSec 2 | Out-Null
      $ready = $true
      break
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  if (-not $ready) { throw 'slinusc server did not become ready' }
  $env:SEARCH_MCP_SSE_URL = 'http://127.0.0.1:8003/sse'
  node 'DESKTOP/scripts/probe-search-mcp-sse.mjs' 'protocol interoperability'
  $probeExit = $LASTEXITCODE
  Write-Output '===== server stderr tail (sanitized) ====='
  $stderrTail = (Get-Content $stderr -Tail 100) -join "`n"
  $stderrTail = $stderrTail.Replace($probeRoot.FullName, '<local-path>')
  $stderrTail = $stderrTail -replace '(?i)(Authorization\s*:\s*Bearer\s+)[^\s,;]+', '$1[redacted]'
  $stderrTail = $stderrTail -replace '(?i)([?&](?:api[_-]?key|access_token|token|key)=)[^&\s]+', '$1[redacted]'
  Write-Output $stderrTail
  Write-Output "probe exit=$probeExit"
} finally {
  Remove-Item Env:SEARCH_MCP_SSE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:SEARXNG_URL -ErrorAction SilentlyContinue
  Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
}
