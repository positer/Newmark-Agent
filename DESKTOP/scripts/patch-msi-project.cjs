const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function readSharedFunctions(names) {
  // Parse the shared helper without dot-sourcing it. The MSI must carry the
  // current cleanup implementation before InstallFiles replaces an old helper.
  const helper = path.join(__dirname, 'install-windows-msi.ps1');
  const extract = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile('${helper.replace(/'/g, "''")}', [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Cannot embed an invalid installer helper' }
$names = @(${names.map(name => `'${name}'`).join(', ')})
$definitions = foreach ($name in $names) {
    $matches = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true))
    if ($matches.Count -ne 1) { throw "Expected one shared installer function: $name" }
    $matches[0].Extent.Text
}
ConvertTo-Json -InputObject @($definitions) -Compress
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(extract, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`Cannot embed MSI cleanup: ${result.error || result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()).join('\n\n');
}

function buildPreInstallScript() {
  const definitions = readSharedFunctions(['Resolve-NewmarkPendingPath', 'Get-NewmarkPendingPlan',
    'Read-NewmarkPendingEntries', 'Write-NewmarkPendingEntries', 'Clear-NewmarkPendingOperations', 'Stop-InstalledNewmark']);
  return String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
${definitions}

try {
    # Type 34 passes APPLICATIONFOLDER as the native working directory. Never
    # inject it into PowerShell source or quote it into an MSI Formatted field.
    $root = [IO.Path]::GetFullPath([Environment]::CurrentDirectory).TrimEnd('\')
    if ($root -eq [IO.Path]::GetPathRoot($root).TrimEnd('\')) { throw 'Refusing an unbounded installation directory' }
    $null = Get-NewmarkPendingPlan -Root $root -Entries @()
    Stop-InstalledNewmark -Root $root
    $pendingResult = Clear-NewmarkPendingOperations -Root $root
    [Console]::Out.WriteLine('Newmark MSI pre-install cleanup completed: ' + $root)
    exit 0
} catch {
    [Console]::Error.WriteLine('Newmark MSI pre-install cleanup failed: ' + $_.Exception.Message)
    exit 1
}
`;
}

function buildPreUpgradeScript(upgradeCode) {
  if (!/^\{?[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}\}?$/.test(upgradeCode)) {
    throw new Error('Cannot author early stop without a concrete MSI UpgradeCode');
  }
  const family = `{${upgradeCode.replace(/[{}]/g, '').toUpperCase()}}`;
  return String.raw`$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
${readSharedFunctions(['Stop-InstalledNewmark'])}

function Get-RegisteredNewmarkRoots([string]$UpgradeCode) {
    $roots = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $installer = New-Object -ComObject WindowsInstaller.Installer
    try {
        $products = $installer.RelatedProducts($UpgradeCode)
        try {
            for ($index=0; $index -lt $products.Count(); $index++) {
                $product = $products.Item($index)
                $cachedPackage = $installer.ProductInfo($product, 'LocalPackage')
                if (-not $cachedPackage -or -not [IO.File]::Exists($cachedPackage)) { throw ('Registered MSI cache is missing: ' + $product) }
                $database = $installer.OpenDatabase($cachedPackage, 0)
                try {
                    $view = $database.OpenView('SELECT FileName, Component_ FROM File')
                    $components = [Collections.Generic.List[string]]::new()
                    try {
                        [void]$view.Execute()
                        $record = $view.Fetch()
                        while ($null -ne $record) {
                            try {
                                if (($record.StringData(1).Split('|')[-1]) -ieq 'Newmark Agent.exe') { [void]$components.Add($record.StringData(2)) }
                            } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record) }
                            $record = $view.Fetch()
                        }
                    } finally { [void]$view.Close(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) }
                    if ($components.Count -ne 1) { throw ('Cannot identify one registered Newmark executable component: ' + $product) }
                    foreach ($component in $components) {
                        $view = $database.OpenView("SELECT ComponentId FROM Component WHERE Component = '" + $component.Replace("'", "''") + "'")
                        try {
                            [void]$view.Execute(); $record = $view.Fetch()
                            if ($null -eq $record) { throw 'Registered executable component is missing' }
                            try { $componentId = $record.StringData(1) }
                            finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($record) }
                        } finally { [void]$view.Close(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) }
                        $executable = $installer.ComponentPath($product, $componentId)
                        if (-not $executable) { throw ('Registered Newmark executable path is unavailable: ' + $product) }
                        if (-not [IO.Path]::IsPathRooted($executable) -or [IO.Path]::GetFileName($executable) -ine 'Newmark Agent.exe') { throw 'Registered executable path is not a Newmark installation' }
                        $root = [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($executable)).TrimEnd('\')
                        if ($root -eq [IO.Path]::GetPathRoot($root).TrimEnd('\')) { throw 'Refusing a drive-root process scope' }
                        [void]$roots.Add($root)
                    }
                } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($database) }
            }
        } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($products) }
    } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer) }
    return @($roots)
}

try {
    $roots = @(Get-RegisteredNewmarkRoots '${family}')
    foreach ($root in $roots) { Stop-InstalledNewmark -Root $root }
    [Console]::Out.WriteLine('Newmark MSI pre-upgrade process stop completed; registered roots: ' + $roots.Count)
    exit 0
} catch {
    [Console]::Error.WriteLine('Newmark MSI pre-upgrade process stop failed: ' + $_.Exception.Message)
    exit 1
}
`;
}

function ensureSystemFolderDirectory(source) {
  // The electron-builder template references standard directory properties but
  // does not declare SystemFolder. Type 34 additionally needs a Directory row.
  if (/<Directory\b[^>]*\bId="SystemFolder"(?:\s|\/|>)/.test(source)) return source;
  const target = /<Directory\b[^>]*\bId="TARGETDIR"[^>]*>/;
  const match = source.match(target);
  if (!match || /\/>$/.test(match[0])) throw new Error('MSI TARGETDIR directory container was not found');
  return source.replace(target, `${match[0]}\n      <Directory Id="SystemFolder"/>`);
}

module.exports = async function msiProjectCreated(projectPath) {
  let source = ensureSystemFolderDirectory(fs.readFileSync(projectPath, 'utf8'));
  const anchor = '    <MediaTemplate CompressionLevel="';
  const mediaIndex = source.indexOf(anchor);
  if (mediaIndex < 0) throw new Error('MSI media anchor was not found');
  const insertAt = source.indexOf('\n', mediaIndex) + 1;
  // Square brackets and conditional braces in inline PowerShell are consumed
  // by MsiFormatRecord. Only the executable path is MSI-formatted; all script
  // bytes use UTF-16LE Base64, which has no MSI formatting metacharacters.
  const encoded = Buffer.from(buildPreInstallScript(), 'utf16le').toString('base64');
  const upgradeCode = source.match(/<Product\b[^>]*\bUpgradeCode="([^"]+)"/);
  if (!upgradeCode) throw new Error('MSI Product UpgradeCode was not found');
  const earlyEncoded = Buffer.from(buildPreUpgradeScript(upgradeCode[1]), 'utf16le').toString('base64');
  if (Math.max(encoded.length, earlyEncoded.length) > 30000) throw new Error('Encoded MSI action exceeds the Windows command-line budget');
  const customActions = `
    <Property Id="MSIRESTARTMANAGERCONTROL" Value="Disable"/>
    <Property Id="REBOOT" Value="ReallySuppress"/>
    <CustomAction Id="StopRegisteredNewmarkBeforeUpgrade"
                  Directory="SystemFolder"
                  ExeCommand="&quot;[SystemFolder]WindowsPowerShell\\v1.0\\powershell.exe&quot; -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ${earlyEncoded}"
                  Execute="immediate"
                  Return="check"/>
    <CustomAction Id="StopRunningNewmark"
                  Directory="APPLICATIONFOLDER"
                  ExeCommand="&quot;[SystemFolder]WindowsPowerShell\\v1.0\\powershell.exe&quot; -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand ${encoded}"
                  Execute="deferred"
                  Impersonate="no"
                  Return="check"/>
    <InstallExecuteSequence>
      <Custom Action="StopRegisteredNewmarkBeforeUpgrade" Before="RemoveExistingProducts">NOT REMOVE~=&quot;ALL&quot;</Custom>
      <Custom Action="StopRunningNewmark" After="CreateFolders">NOT REMOVE~=&quot;ALL&quot;</Custom>
    </InstallExecuteSequence>
`;
  source = source.slice(0, insertAt) + customActions + source.slice(insertAt);
  const componentPattern = /(<Component(?:\s[^>]*)?>[\s\S]*?<File Name="Newmark\.exe"[\s\S]*?\/>)([\s\S]*?<\/Component>)/;
  if (!componentPattern.test(source)) {
    throw new Error('MSI project does not contain the console Newmark.exe component');
  }
  const environment = [
    '      <CreateFolder/>',
    '      <Environment Id="NewmarkGlobalPath"',
    '        Name="PATH"',
    '        Value="[APPLICATIONFOLDER]"',
    '        Action="set"',
    '        Part="last"',
    '        Permanent="no"',
    '        System="no"/>',
  ].join('\n');
  source = source.replace(componentPattern, `$1\n${environment}$2`);
  fs.writeFileSync(projectPath, source, 'utf8');
};

module.exports.buildPreInstallScript = buildPreInstallScript;
module.exports.buildPreUpgradeScript = buildPreUpgradeScript;
module.exports.ensureSystemFolderDirectory = ensureSystemFolderDirectory;
