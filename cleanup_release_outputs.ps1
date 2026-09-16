$root = 'C:\Users\12252\Desktop\Files\Code\Newmark Agent'
$apk = Join-Path $root 'APK'
if (Test-Path $apk) { Get-ChildItem -LiteralPath $apk -Force | Remove-Item -Recurse -Force }
Get-ChildItem -LiteralPath $root -Directory | Where-Object { $_.Name -like 'release*' } | ForEach-Object {
  Remove-Item -LiteralPath $_.FullName -Recurse -Force
}
Write-Output "CLEANED"
