$ErrorActionPreference = 'Stop'
$key = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager'
$name = 'PendingFileRenameOperations'
$value = (Get-ItemProperty -LiteralPath $key -Name $name -ErrorAction SilentlyContinue).$name
if (-not $value) {
  Write-Output 'REMOVED_NEWMARK_PENDING=0'
  exit 0
}
$kept = [System.Collections.Generic.List[string]]::new()
$removed = 0
for ($i = 0; $i -lt $value.Count; $i += 2) {
  $source = [string]$value[$i]
  $destination = if ($i + 1 -lt $value.Count) { [string]$value[$i + 1] } else { '' }
  if ($source -like '*\Program Files\Newmark Agent\*' -or $destination -like '*\Program Files\Newmark Agent\*') {
    $removed += 1
    continue
  }
  $kept.Add($source)
  if ($i + 1 -lt $value.Count) { $kept.Add($destination) }
}
if ($kept.Count) {
  Set-ItemProperty -LiteralPath $key -Name $name -Value $kept.ToArray()
} else {
  Remove-ItemProperty -LiteralPath $key -Name $name -ErrorAction SilentlyContinue
}
Write-Output "REMOVED_NEWMARK_PENDING=$removed"
