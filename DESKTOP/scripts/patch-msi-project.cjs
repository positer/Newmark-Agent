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
                  ExeCommand="-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command &quot;Get-Process -Name 'Newmark Agent' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue&quot;"
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
