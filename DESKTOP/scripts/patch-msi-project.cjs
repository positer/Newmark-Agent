const fs = require('fs');

module.exports = async function msiProjectCreated(projectPath) {
  let source = fs.readFileSync(projectPath, 'utf8');
  const anchor = '    <MediaTemplate CompressionLevel="';
  const mediaIndex = source.indexOf(anchor);
  if (mediaIndex < 0) throw new Error('MSI media anchor was not found');
  const insertAt = source.indexOf('\n', mediaIndex) + 1;
  const customActions = `
    <Property Id="NEWMARK_POWERSHELL" Value="powershell.exe"/>
    <Property Id="MSIRESTARTMANAGERCONTROL" Value="Disable"/>
    <Property Id="REBOOT" Value="ReallySuppress"/>
    <CustomAction Id="StopRunningNewmark"
                  Property="NEWMARK_POWERSHELL"
                  ExeCommand="-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command &quot;$root=[IO.Path]::GetFullPath('[APPLICATIONFOLDER]').TrimEnd('\') + '\'; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) + '').StartsWith($root,[StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; $pending=@((Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue).PendingFileRenameOperations); if($pending.Count){ $filtered=@(); for($i=0;$i -lt $pending.Count;$i+=2){ $from=[Environment]::ExpandEnvironmentVariables([string]$pending[$i]).TrimStart('!','\','?'); $to=if($i+1 -lt $pending.Count){[Environment]::ExpandEnvironmentVariables([string]$pending[$i+1]).TrimStart('!','\','?')}else{''}; if(-not ($from.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) -or $to.StartsWith($root,[StringComparison]::OrdinalIgnoreCase))){ $filtered += [string]$pending[$i]; if($i+1 -lt $pending.Count){$filtered += [string]$pending[$i+1]} } }; if($filtered.Count){ Set-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -Type MultiString -Value $filtered } else { Remove-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue } }&quot;"
                  Execute="deferred"
                  Impersonate="no"
                  Return="ignore"/>
    <InstallExecuteSequence>
      <Custom Action="StopRunningNewmark" After="InstallInitialize">NOT REMOVE~=&quot;ALL&quot;</Custom>
    </InstallExecuteSequence>
`;
  source = source.slice(0, insertAt) + customActions + source.slice(insertAt);
  const componentPattern = /(<Component(?:\s[^>]*)?>[\s\S]*?<File Name="Newmark\.exe"[\s\S]*?\/>)([\s\S]*?<\/Component>)/;
  if (!componentPattern.test(source)) {
    throw new Error('MSI project does not contain the console Newmark.exe component');
  }
  const environment = [
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
