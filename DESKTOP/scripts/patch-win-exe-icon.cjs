const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function fail(message) {
  throw new Error(message);
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function parseIco(iconPath) {
  const buf = fs.readFileSync(iconPath);
  if (buf.length < 6 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) {
    fail(`not a Windows ICO file: ${iconPath}`);
  }
  const count = buf.readUInt16LE(4);
  if (count <= 0) fail(`ICO has no images: ${iconPath}`);
  const images = [];
  for (let i = 0; i < count; i++) {
    const offset = 6 + i * 16;
    const size = buf.readUInt32LE(offset + 8);
    const imageOffset = buf.readUInt32LE(offset + 12);
    if (imageOffset < 0 || size <= 0 || imageOffset + size > buf.length) {
      fail(`ICO image ${i} has invalid bounds`);
    }
    images.push({
      widthByte: buf[offset],
      heightByte: buf[offset + 1],
      colorCount: buf[offset + 2],
      reserved: buf[offset + 3],
      planes: buf.readUInt16LE(offset + 4),
      bitCount: buf.readUInt16LE(offset + 6),
      bytesInRes: size,
      data: buf.subarray(imageOffset, imageOffset + size),
    });
  }
  return images;
}

function buildGroupIcon(images, baseId) {
  const group = Buffer.alloc(6 + images.length * 14);
  group.writeUInt16LE(0, 0);
  group.writeUInt16LE(1, 2);
  group.writeUInt16LE(images.length, 4);
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const offset = 6 + i * 14;
    group[offset] = img.widthByte;
    group[offset + 1] = img.heightByte;
    group[offset + 2] = img.colorCount;
    group[offset + 3] = img.reserved;
    group.writeUInt16LE(img.planes, offset + 4);
    group.writeUInt16LE(img.bitCount, offset + 6);
    group.writeUInt32LE(img.bytesInRes, offset + 8);
    group.writeUInt16LE(baseId + i, offset + 12);
  }
  return group;
}

function generateDibIconSource(pngPath) {
  if (process.platform !== 'win32') return null;
  if (!fs.existsSync(pngPath)) fail(`missing PNG icon source: ${pngPath}`);
  const outPath = path.join(os.tmpdir(), `newmark-dib-icon-${process.pid}-${Date.now()}.ico`);
  const ps = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$source = ${psQuote(path.resolve(pngPath))}
$out = ${psQuote(outPath)}
$sizes = @(256,128,64,48,32,16)
$src = [System.Drawing.Image]::FromFile($source)
$entries = New-Object System.Collections.Generic.List[object]
$imageData = New-Object System.Collections.Generic.List[byte[]]
foreach ($size in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.DrawImage($src, 0, 0, $size, $size)
  $g.Dispose()
  $stride = $size * 4
  $xor = New-Object byte[] ($stride * $size)
  for ($y = 0; $y -lt $size; $y++) {
    for ($x = 0; $x -lt $size; $x++) {
      $c = $bmp.GetPixel($x, $size - 1 - $y)
      $idx = $y * $stride + $x * 4
      $xor[$idx] = $c.B
      $xor[$idx + 1] = $c.G
      $xor[$idx + 2] = $c.R
      $xor[$idx + 3] = $c.A
    }
  }
  $andStride = [int]([Math]::Ceiling($size / 32.0) * 4)
  $and = New-Object byte[] ($andStride * $size)
  $ms = New-Object IO.MemoryStream
  $bw = New-Object IO.BinaryWriter($ms)
  $bw.Write([UInt32]40)
  $bw.Write([Int32]$size)
  $bw.Write([Int32]($size * 2))
  $bw.Write([UInt16]1)
  $bw.Write([UInt16]32)
  $bw.Write([UInt32]0)
  $bw.Write([UInt32]($xor.Length + $and.Length))
  $bw.Write([Int32]0)
  $bw.Write([Int32]0)
  $bw.Write([UInt32]0)
  $bw.Write([UInt32]0)
  $bw.Write($xor)
  $bw.Write($and)
  $bw.Flush()
  $bytes = $ms.ToArray()
  $imageData.Add($bytes)
  $entries.Add([PSCustomObject]@{ Size = $size; Length = $bytes.Length })
  $bw.Dispose()
  $ms.Dispose()
  $bmp.Dispose()
}
$fs = [IO.File]::Create($out)
$writer = New-Object IO.BinaryWriter($fs)
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]$entries.Count)
$offset = 6 + ($entries.Count * 16)
for ($i = 0; $i -lt $entries.Count; $i++) {
  $entry = $entries[$i]
  $sizeByte = if ($entry.Size -eq 256) { 0 } else { [byte]$entry.Size }
  $writer.Write([byte]$sizeByte)
  $writer.Write([byte]$sizeByte)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]32)
  $writer.Write([UInt32]$entry.Length)
  $writer.Write([UInt32]$offset)
  $offset += $entry.Length
}
foreach ($bytes in $imageData) { $writer.Write($bytes) }
$writer.Dispose()
$fs.Dispose()
$src.Dispose()
Write-Output $out
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(result.stderr || result.stdout || `DIB ICO generation failed with exit ${result.status}`);
  if (!fs.existsSync(outPath) || fs.statSync(outPath).size <= 0) fail(`DIB ICO generation produced no output: ${outPath}`);
  return outPath;
}

function writeIconResources(exePath, iconPath) {
  if (process.platform !== 'win32') return;
  if (!fs.existsSync(exePath)) fail(`missing exe: ${exePath}`);
  if (!fs.existsSync(iconPath)) fail(`missing icon: ${iconPath}`);

  const images = parseIco(iconPath);
  const baseId = 200;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newmark-exe-icon-'));
  const manifestPath = path.join(tempDir, 'manifest.json');
  const groupPath = path.join(tempDir, 'group.bin');
  const groupData = buildGroupIcon(images, baseId);
  fs.writeFileSync(groupPath, groupData);
  const imageEntries = images.map((img, idx) => {
    const imagePath = path.join(tempDir, `icon-${baseId + idx}.bin`);
    fs.writeFileSync(imagePath, img.data);
    return { id: baseId + idx, path: imagePath };
  });
  fs.writeFileSync(manifestPath, JSON.stringify({
    exe: path.resolve(exePath),
    groupPath,
    groupId: 1,
    languages: [0, 1033],
    images: imageEntries,
  }, null, 2));

  const ps = `
$ErrorActionPreference = "Stop"
$manifest = Get-Content -LiteralPath ${psQuote(manifestPath)} -Raw | ConvertFrom-Json
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class NewmarkResourceWriter {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool UpdateResource(IntPtr hUpdate, IntPtr lpType, IntPtr lpName, ushort wLanguage, byte[] lpData, uint cbData);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);
}
"@
function ThrowLastWin32($message) {
  $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  throw "$message Win32Error=$err"
}
$h = [NewmarkResourceWriter]::BeginUpdateResource([string]$manifest.exe, $false)
if ($h -eq [IntPtr]::Zero) { ThrowLastWin32 "BeginUpdateResource failed" }
try {
  foreach ($langValue in @($manifest.languages)) {
    $lang = [uint16]$langValue
    foreach ($img in @($manifest.images)) {
      [byte[]]$data = [IO.File]::ReadAllBytes([string]$img.path)
      $ok = [NewmarkResourceWriter]::UpdateResource($h, [IntPtr]3, [IntPtr]([int]$img.id), $lang, $data, [uint32]$data.Length)
      if (-not $ok) { ThrowLastWin32 "UpdateResource RT_ICON failed" }
    }
    [byte[]]$group = [IO.File]::ReadAllBytes([string]$manifest.groupPath)
    $ok = [NewmarkResourceWriter]::UpdateResource($h, [IntPtr]14, [IntPtr]([int]$manifest.groupId), $lang, $group, [uint32]$group.Length)
    if (-not $ok) { ThrowLastWin32 "UpdateResource RT_GROUP_ICON failed" }
  }
  $saved = [NewmarkResourceWriter]::EndUpdateResource($h, $false)
  $h = [IntPtr]::Zero
  if (-not $saved) { ThrowLastWin32 "EndUpdateResource save failed" }
} catch {
  if ($h -ne [IntPtr]::Zero) { [void][NewmarkResourceWriter]::EndUpdateResource($h, $true) }
  throw
}
Write-Output "RESOURCE_ICON_UPDATED"
`;

  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    encoding: 'utf8',
    windowsHide: true,
  });
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(result.stderr || result.stdout || `resource icon patch failed with exit ${result.status}`);
}

function associatedIconHash(targetPath, icoMode, requestedSize = 256) {
  const ps = `
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$target = ${psQuote(path.resolve(targetPath))}
$out = Join-Path $env:TEMP ("newmark-associated-icon-" + [Guid]::NewGuid().ToString("N") + ".png")
  if (${icoMode ? '$true' : '$false'}) {
  $icon = New-Object System.Drawing.Icon($target, ${Number(requestedSize)}, ${Number(requestedSize)})
} else {
  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($target)
}
if ($null -eq $icon) { throw "associated icon missing" }
$bmp = $icon.ToBitmap()
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$hash = (Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash
$w = $bmp.Width
$h = $bmp.Height
$bmp.Dispose()
$icon.Dispose()
Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
Write-Output "$hash|$w|$h"
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(result.stderr || result.stdout || `associated icon hash failed for ${targetPath}`);
  const line = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  const [hash, width, height] = line.split('|');
  if (!hash || !width || !height) fail(`invalid associated icon hash output for ${targetPath}: ${line}`);
  return { hash, width: Number(width), height: Number(height) };
}

function verifyExeIcon(exePath, iconPath) {
  if (process.platform !== 'win32') return { skipped: true };
  let comparableIconPath = iconPath;
  let cleanupPath = null;
  const pngSource = path.join(path.dirname(iconPath), 'app-icon-dark.png');
  if (fs.existsSync(pngSource)) {
    cleanupPath = generateDibIconSource(pngSource);
    comparableIconPath = cleanupPath;
  }
  try {
    const actual = associatedIconHash(exePath, false);
    const size = Math.max(16, Math.min(256, actual.width || 32, actual.height || 32));
    const expected = associatedIconHash(comparableIconPath, true, size);
    if (actual.hash !== expected.hash) {
      fail(`win-unpacked exe associated icon does not match patched icon at ${size}px: expected ${expected.hash} ${expected.width}x${expected.height}, got ${actual.hash} ${actual.width}x${actual.height}`);
    }
    return { expected, actual };
  } finally {
    if (cleanupPath) fs.rmSync(cleanupPath, { force: true });
  }
}

function patchAndVerify(exePath, iconPath) {
  let resourceIconPath = iconPath;
  let cleanupPath = null;
  const pngSource = path.join(path.dirname(iconPath), 'app-icon-dark.png');
  if (process.platform === 'win32' && fs.existsSync(pngSource)) {
    cleanupPath = generateDibIconSource(pngSource);
    resourceIconPath = cleanupPath;
  }
  try {
    writeIconResources(exePath, resourceIconPath);
    return verifyExeIcon(exePath, resourceIconPath);
  } finally {
    if (cleanupPath) fs.rmSync(cleanupPath, { force: true });
  }
}

if (require.main === module) {
  const exe = process.argv[2];
  const icon = process.argv[3];
  if (!exe || !icon) {
    console.error('Usage: node scripts/patch-win-exe-icon.cjs <exe> <icon.ico>');
    process.exit(2);
  }
  try {
    const result = patchAndVerify(exe, icon);
    console.log(`[patch-win-exe-icon] ok ${JSON.stringify(result)}`);
  } catch (err) {
    console.error(`[patch-win-exe-icon] ${err.message}`);
    process.exit(1);
  }
}

module.exports = { patchAndVerify, verifyExeIcon };
