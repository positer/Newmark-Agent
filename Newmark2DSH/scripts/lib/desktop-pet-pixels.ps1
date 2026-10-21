param([Parameter(Mandatory=$true)][string]$EvidenceDirectory)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$a=[Drawing.Bitmap]::FromFile((Join-Path $EvidenceDirectory 'pet-collapsed-a.png'))
$b=[Drawing.Bitmap]::FromFile((Join-Path $EvidenceDirectory 'pet-collapsed-b.png'))
$grayChanges=0; $interiorChanges=0
try {
    for($y=0;$y -lt $a.Height;$y++) { for($x=0;$x -lt $a.Width;$x++) {
        $p=$a.GetPixel($x,$y); $q=$b.GetPixel($x,$y)
        if ($p.ToArgb() -eq $q.ToArgb()) { continue }
        if ($p.R -eq $p.G -and $p.G -eq $p.B -and $q.R -eq $q.G -and $q.G -eq $q.B -and [Math]::Abs([int]$p.R-[int]$q.R) -gt 10) { $grayChanges++ }
        # Elastic animation adds transparent padding. The old 20% top boundary
        # crossed the sloped outer silhouette; use the central face region.
        if ($x -gt $a.Width*0.25 -and $x -lt $a.Width*0.7 -and $y -gt $a.Height*0.25 -and $y -lt $a.Height*0.75) { $interiorChanges++ }
    } }
    $result=@{animated_grayscale_pixels=$grayChanges;body_interior_changed_pixels=$interiorChanges;pass=($grayChanges -gt 100 -and $interiorChanges -eq 0)}
    $result | ConvertTo-Json | Set-Content (Join-Path $EvidenceDirectory 'pixel-results.json')
    $result | ConvertTo-Json -Compress
    if(-not $result.pass) { exit 1 }
} finally { $a.Dispose(); $b.Dispose() }
