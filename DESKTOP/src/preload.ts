const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  sendMessage: (message: string, conversationId?: string) => ipcRenderer.invoke('agent:send', message, conversationId),
  sendPrompt: (message: string, _model?: string) => ipcRenderer.invoke('agent:sendPrompt', message),
  setMode: (mode: string) => ipcRenderer.invoke('agent:setMode', mode),
  setModel: (model: string) => ipcRenderer.invoke('agent:setModel', model),
  setIntelligence: (tier: string) => ipcRenderer.invoke('agent:setIntelligence', tier),
  setInputMode: (mode: string) => ipcRenderer.invoke('agent:setInputMode', mode),
  setConversation: (id: string) => ipcRenderer.invoke('agent:setConversation', id),
  updateGoal: (goal: string) => ipcRenderer.invoke('agent:updateGoal', goal),
  toggleGoalPause: () => ipcRenderer.invoke('agent:toggleGoalPause'),
  getState: () => ipcRenderer.invoke('agent:getState'),
  getConversationPlan: () => ipcRenderer.invoke('agent:getConversationPlan'),
  updateConversationPlan: (plan: Record<string, unknown>) => ipcRenderer.invoke('agent:updateConversationPlan', plan),
  browserControl: (request: Record<string, unknown>) => ipcRenderer.invoke('browser:control', request),
  runFlow: (name: string, input?: string, start?: number) => ipcRenderer.invoke('flow:run', name, input, start),
  saveConfig: (cfg: string | Record<string, unknown>) => ipcRenderer.invoke('agent:saveConfig', cfg),
  abortConversation: (conversationId?: string) => ipcRenderer.invoke('agent:abortConversation', conversationId),
  archive: (conversationId?: string) => ipcRenderer.invoke('agent:archive', conversationId),
  listArchives: () => ipcRenderer.invoke('agent:listArchives'),
  deleteArchive: (name: string) => ipcRenderer.invoke('agent:deleteArchive', name),
  readArchive: (name: string) => ipcRenderer.invoke('agent:readArchive', name),
  readFile: (path: string) => ipcRenderer.invoke('agent:readFile', path),
  saveFile: (path: string, content: string) => ipcRenderer.invoke('agent:saveFile', path, content),
  filePathForFile: (file: File) => {
    try {
      return webUtils && file ? webUtils.getPathForFile(file) : '';
    } catch {
      return '';
    }
  },
  listFiles: (dir: string) => ipcRenderer.invoke('agent:listFiles', dir),
  getFileTree: (dir?: string) => ipcRenderer.invoke('agent:getFileTree', dir),
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  executeBash: (cmd: string, shell: string, cwd: string) => ipcRenderer.invoke('agent:executeBash', cmd, shell, cwd),
  openExternal: (path: string) => ipcRenderer.invoke('agent:openExternal', path),
  selectWorkspace: (id: string) => ipcRenderer.invoke('agent:selectWorkspace', id),
  createWorkspace: (name?: string) => ipcRenderer.invoke('agent:createWorkspace', name),
  createExternalWorkspace: (name: string, dirPath: string) => ipcRenderer.invoke('agent:createExternalWorkspace', name, dirPath),
  deleteWorkspace: (name: string) => ipcRenderer.invoke('agent:deleteWorkspace', name),
  saveSetting: (section: string, key: string, value: unknown) => ipcRenderer.invoke('agent:saveSetting', section, key, value),
  validateModels: (selected?: string[]) => ipcRenderer.invoke('agent:validateModels', selected),
  fuzzyInject: (name: string, url: string, key: string, protocol?: string) => ipcRenderer.invoke('agent:fuzzyInject', name, url, key, protocol),
  listSkills: () => ipcRenderer.invoke('skills:list'),
  marketSkills: () => ipcRenderer.invoke('skills:market'),
  marketSkillSources: () => ipcRenderer.invoke('skills:marketSources'),
  addSkillMarketSource: (input: Record<string, unknown>) => ipcRenderer.invoke('skills:addMarketSource', input),
  removeSkillMarketSource: (idOrName: string) => ipcRenderer.invoke('skills:removeMarketSource', idOrName),
  setSkillMarketSourceEnabled: (idOrName: string, enabled: boolean) => ipcRenderer.invoke('skills:setMarketSourceEnabled', idOrName, enabled),
  downloadSkill: (name: string, url: string) => ipcRenderer.invoke('skills:download', name, url),
  installLocalSkill: (sourceDir: string, targetName?: string) => ipcRenderer.invoke('skills:installLocal', sourceDir, targetName),
  setSkillEnabled: (name: string, enabled: boolean) => ipcRenderer.invoke('skills:setEnabled', name, enabled),
  removeSkill: (name: string) => ipcRenderer.invoke('skills:remove', name),
  refreshSkills: () => ipcRenderer.invoke('skills:refresh'),
  memoryLabRead: (selector?: string) => ipcRenderer.invoke('memoryLab:read', selector),
  memoryLabUpdate: (input: Record<string, unknown>) => ipcRenderer.invoke('memoryLab:update', input),
  memoryLabReindex: () => ipcRenderer.invoke('memoryLab:reindex'),
  updateVersion: () => ipcRenderer.invoke('update:version'),
  updateCheckGithub: (input: Record<string, unknown>) => ipcRenderer.invoke('update:checkGithub', input),
  updateApplyGithub: (input: Record<string, unknown>) => ipcRenderer.invoke('update:applyGithub', input),
  updateInstallLocal: (input: Record<string, unknown>) => ipcRenderer.invoke('update:installLocal', input),
  gh: (argv: string[]) => ipcRenderer.invoke('github:gh', argv),
  listAutomations: () => ipcRenderer.invoke('automation:list'),
  createAutomation: (item: Record<string, unknown>) => ipcRenderer.invoke('automation:create', item),
  toggleAutomation: (id: string) => ipcRenderer.invoke('automation:toggle', id),
  deleteAutomation: (id: string) => ipcRenderer.invoke('automation:delete', id),
  automationWakeStatus: () => ipcRenderer.invoke('automation:wakeStatus'),
  minimize: () => ipcRenderer.invoke('app:minimize'),
  maximize: () => ipcRenderer.invoke('app:maximize'),
  close: () => ipcRenderer.invoke('app:close'),
  sidecarStatus: () => ipcRenderer.invoke('sidecar:status'),
  sidecarRestart: () => ipcRenderer.invoke('sidecar:restart'),
  // Native PTY Terminal
  terminalSpawn: (shell: string) => ipcRenderer.invoke('pty:spawn', shell),
  terminalWrite: (sessionId: string, data: string) => ipcRenderer.invoke('pty:write', sessionId, data),
  terminalKill: (sessionId: string, timeoutMs?: number) => ipcRenderer.invoke('pty:kill', sessionId, timeoutMs),
  terminalGetBuffer: (sessionId: string) => ipcRenderer.invoke('pty:getBuffer', sessionId),
  wslDetect: () => ipcRenderer.invoke('wsl:detect'),
  onTerminalData: (callback: (event: unknown, sessionId: string, data: string) => void) => {
    ipcRenderer.on('pty:data', callback);
  },
  onTerminalExit: (callback: (event: unknown, sessionId: string, code: number) => void) => {
    ipcRenderer.on('pty:exit', callback);
  },
  removeTerminalDataListener: () => {
    ipcRenderer.removeAllListeners('pty:data');
  },
  onAutomationUpdated: (callback: () => void) => {
    ipcRenderer.on('automation:updated', callback);
  },
  onAgentWorkEvent: (callback: (event: unknown, payload: unknown) => void) => {
    ipcRenderer.on('agent:workEvent', callback);
  },
  removeAgentWorkEventListener: () => {
    ipcRenderer.removeAllListeners('agent:workEvent');
  },
});
