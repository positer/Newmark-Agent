import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { AutomationSchedule } from './automation';

export interface WakeCommandResult {
  ok: boolean;
  command: string;
  args: string[];
  error?: string;
}

export type WakeCommandRunner = (command: string, args: string[]) => WakeCommandResult;

export interface WakeSyncResult {
  platform: string;
  active: boolean;
  nextRunAt: string;
  taskName: string;
  registered: boolean;
  deleted: boolean;
  skippedReason: string;
  commandResult?: WakeCommandResult;
}

export class AutomationWakeScheduler {
  constructor(
    private rootPath: string,
    private exePath: string,
    private runner: WakeCommandRunner = defaultWakeCommandRunner
  ) {}

  taskName(): string {
    const safeRoot = this.rootPath.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(-80) || 'default';
    return `NewmarkAgent_Automation_${safeRoot}`;
  }

  nextActiveRun(schedules: AutomationSchedule[], now = new Date()): AutomationSchedule | null {
    const candidates = schedules
      .filter(s => s.active && s.nextRunAt && s.status !== 'completed')
      .filter(s => {
        if (!s.endAt) return true;
        return new Date(s.endAt).getTime() >= now.getTime();
      })
      .sort((a, b) => new Date(a.nextRunAt).getTime() - new Date(b.nextRunAt).getTime());
    return candidates[0] || null;
  }

  sync(schedules: AutomationSchedule[], now = new Date()): WakeSyncResult {
    const taskName = this.taskName();
    if (process.platform !== 'win32') {
      return {
        platform: process.platform,
        active: false,
        nextRunAt: '',
        taskName,
        registered: false,
        deleted: false,
        skippedReason: 'OS-level wake scheduling is currently implemented with Windows Task Scheduler only.',
      };
    }

    const next = this.nextActiveRun(schedules, now);
    if (!next) {
      const commandResult = this.deleteWindowsTask(taskName);
      return {
        platform: process.platform,
        active: false,
        nextRunAt: '',
        taskName,
        registered: false,
        deleted: commandResult.ok,
        skippedReason: '',
        commandResult,
      };
    }

    const xmlPath = this.writeWindowsTaskXml(taskName, next.nextRunAt);
    const commandResult = this.runner('schtasks.exe', ['/Create', '/TN', taskName, '/XML', xmlPath, '/F']);
    return {
      platform: process.platform,
      active: true,
      nextRunAt: next.nextRunAt,
      taskName,
      registered: commandResult.ok,
      deleted: false,
      skippedReason: '',
      commandResult,
    };
  }

  writeWindowsTaskXml(taskName: string, nextRunAt: string): string {
    const dir = path.join(this.rootPath, 'Work');
    fs.mkdirSync(dir, { recursive: true });
    const xmlPath = path.join(dir, 'AutomationWake.Task.xml');
    const startBoundary = toTaskSchedulerLocal(nextRunAt);
    const command = xmlEscape(this.exePath);
    const args = xmlEscape(`--root "${this.rootPath}" --automation-wake`);
    const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Wake Newmark Agent to run due automations.</Description>
    <URI>\\${xmlEscape(taskName)}</URI>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${xmlEscape(startBoundary)}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlEscape(os.userInfo().username)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <WakeToRun>true</WakeToRun>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${command}</Command>
      <Arguments>${args}</Arguments>
      <WorkingDirectory>${xmlEscape(this.rootPath)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
    fs.writeFileSync(xmlPath, Buffer.from(`\ufeff${xml}`, 'utf16le'));
    return xmlPath;
  }

  private deleteWindowsTask(taskName: string): WakeCommandResult {
    return this.runner('schtasks.exe', ['/Delete', '/TN', taskName, '/F']);
  }
}

function defaultWakeCommandRunner(command: string, args: string[]): WakeCommandResult {
  const result = spawnSync(command, args, { windowsHide: true, encoding: 'utf-8' });
  return {
    ok: result.status === 0,
    command,
    args,
    error: result.status === 0 ? undefined : (result.stderr || result.stdout || `exit ${result.status}`),
  };
}

function toTaskSchedulerLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 19);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
