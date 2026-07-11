export interface NativeToolCatalogEntry {
  name: string;
  label: string;
  description: string;
  category: 'core' | 'browser' | 'desktop' | 'agent' | 'workflow' | 'memory' | 'automation' | 'git' | 'github' | 'web' | 'ssh';
  defaultEnabled: boolean;
  protected?: boolean;
}

export const NATIVE_TOOL_CATALOG: NativeToolCatalogEntry[] = [
  { name: 'bash', label: 'Shell command', description: 'Run one-shot PowerShell or bash commands inside the workspace.', category: 'core', defaultEnabled: true },
  { name: 'pwd', label: 'Working directory', description: 'Report the active workspace path.', category: 'core', defaultEnabled: true, protected: true },
  { name: 'read', label: 'Read file', description: 'Read workspace file contents.', category: 'core', defaultEnabled: true },
  { name: 'write', label: 'Write file', description: 'Create or overwrite workspace files.', category: 'core', defaultEnabled: true },
  { name: 'edit', label: 'Edit file', description: 'Patch workspace files through exact find and replace.', category: 'core', defaultEnabled: true },
  { name: 'glob', label: 'Glob files', description: 'Find files by glob pattern.', category: 'core', defaultEnabled: true },
  { name: 'grep', label: 'Search files', description: 'Search workspace text by regex.', category: 'core', defaultEnabled: true },
  { name: 'web_search', label: 'Web search', description: 'Search the web from the Agent.', category: 'web', defaultEnabled: true },
  { name: 'web_fetch', label: 'Web fetch', description: 'Fetch and extract URL text.', category: 'web', defaultEnabled: true },
  { name: 'browser_open', label: 'Browser open', description: 'Open a URL in the built-in browser control.', category: 'browser', defaultEnabled: true },
  { name: 'browser_snapshot', label: 'Browser snapshot', description: 'Read URL, title, and page text from the built-in browser.', category: 'browser', defaultEnabled: true },
  { name: 'browser_click', label: 'Browser click', description: 'Click a CSS selector in the built-in browser.', category: 'browser', defaultEnabled: true },
  { name: 'browser_type', label: 'Browser type', description: 'Type into a CSS selector in the built-in browser.', category: 'browser', defaultEnabled: true },
  { name: 'browser_eval', label: 'Browser eval', description: 'Evaluate page JavaScript in the built-in browser.', category: 'browser', defaultEnabled: true },
  { name: 'browser_back', label: 'Browser back', description: 'Navigate the built-in browser backward.', category: 'browser', defaultEnabled: true },
  { name: 'browser_forward', label: 'Browser forward', description: 'Navigate the built-in browser forward.', category: 'browser', defaultEnabled: true },
  { name: 'browser_reload', label: 'Browser reload', description: 'Reload the built-in browser.', category: 'browser', defaultEnabled: true },
  { name: 'browser_cdp', label: 'Browser CDP', description: 'Run an advanced Chrome DevTools Protocol command.', category: 'browser', defaultEnabled: true },
  { name: 'computer_use', label: 'Computer Use', description: 'Observe and control Windows desktop UI with screenshots and semantic objects.', category: 'desktop', defaultEnabled: true },
  { name: 'image_inspect', label: 'Image inspect', description: 'Crop and magnify images submitted in the current conversation for closer visual inspection.', category: 'core', defaultEnabled: true },
  { name: 'terminal_takeover', label: 'Terminal takeover', description: 'Maintain a persistent Agent-controlled shell session.', category: 'desktop', defaultEnabled: true },
  { name: 'ssh_workspace', label: 'OpenSSH workspace', description: 'Manage native OpenSSH connections and link remote workspaces by PC_Hash.', category: 'ssh', defaultEnabled: true },
  { name: 'task', label: 'Subagent task', description: 'Create a constrained subagent for parallel work.', category: 'agent', defaultEnabled: true },
  { name: 'subagent_send', label: 'Subagent send', description: 'Continue an existing subagent.', category: 'agent', defaultEnabled: true },
  { name: 'subagent_result', label: 'Subagent result', description: 'Read subagent transcript and result.', category: 'agent', defaultEnabled: true },
  { name: 'subagent_close', label: 'Subagent close', description: 'Close an existing subagent.', category: 'agent', defaultEnabled: true },
  { name: 'question', label: 'Ask question', description: 'Ask the user for structured option feedback.', category: 'agent', defaultEnabled: true },
  { name: 'skill_download', label: 'Skill download', description: 'Download and install a skill.', category: 'agent', defaultEnabled: true },
  { name: 'flow_list', label: 'Flow list', description: 'List saved Flow workflows.', category: 'workflow', defaultEnabled: true },
  { name: 'flow_save', label: 'Flow save', description: 'Create or update a Flow workflow.', category: 'workflow', defaultEnabled: true },
  { name: 'flow_run', label: 'Flow run', description: 'Run a saved Flow workflow.', category: 'workflow', defaultEnabled: true },
  { name: 'memory_lab_read', label: 'Memory Lab read', description: 'Read Memory Lab index and components.', category: 'memory', defaultEnabled: true },
  { name: 'memory_lab_update', label: 'Memory Lab update', description: 'Create or update Memory Lab components.', category: 'memory', defaultEnabled: true },
  { name: 'memory_lab_reindex', label: 'Memory Lab reindex', description: 'Rebuild Memory Lab links.', category: 'memory', defaultEnabled: true },
  { name: 'automation_list', label: 'Automation list', description: 'List persisted automations.', category: 'automation', defaultEnabled: true },
  { name: 'automation_create', label: 'Automation create', description: 'Create a persisted automation.', category: 'automation', defaultEnabled: true },
  { name: 'automation_update', label: 'Automation update', description: 'Update a persisted automation.', category: 'automation', defaultEnabled: true },
  { name: 'automation_toggle', label: 'Automation toggle', description: 'Pause or resume a persisted automation.', category: 'automation', defaultEnabled: true },
  { name: 'automation_delete', label: 'Automation delete', description: 'Delete a persisted automation.', category: 'automation', defaultEnabled: true },
  { name: 'git_status', label: 'Git status', description: 'Inspect git working tree status.', category: 'git', defaultEnabled: true },
  { name: 'file_audit', label: 'File audit', description: 'Audit local and GitHub-backed file metadata.', category: 'git', defaultEnabled: true },
  { name: 'repo_security_audit', label: 'Repository security audit', description: 'Review remote repository privacy and release risk.', category: 'git', defaultEnabled: true },
  { name: 'git_pull', label: 'Git pull', description: 'Pull changes from a remote.', category: 'git', defaultEnabled: true },
  { name: 'git_push', label: 'Git push', description: 'Stage, commit, and push changes.', category: 'git', defaultEnabled: true },
  { name: 'git_clone', label: 'Git clone', description: 'Clone a git repository.', category: 'git', defaultEnabled: true },
  { name: 'git_branch', label: 'Git branch', description: 'Inspect, create, or switch local branches.', category: 'git', defaultEnabled: true },
  { name: 'gh_auth_status', label: 'GitHub auth status', description: 'Check GitHub CLI authentication.', category: 'github', defaultEnabled: true },
  { name: 'gh_repo_view', label: 'GitHub repo view', description: 'Inspect GitHub repository metadata.', category: 'github', defaultEnabled: true },
  { name: 'gh_issue_list', label: 'GitHub issues', description: 'List GitHub issues.', category: 'github', defaultEnabled: true },
  { name: 'gh_pr_list', label: 'GitHub pull requests', description: 'List GitHub pull requests.', category: 'github', defaultEnabled: true },
  { name: 'gh_fork', label: 'GitHub fork', description: 'Inspect or create GitHub forks.', category: 'github', defaultEnabled: true },
  { name: 'gh_pr_create', label: 'GitHub PR create', description: 'Create GitHub pull requests.', category: 'github', defaultEnabled: true },
];

export function defaultNativeToolEnabled(): Record<string, boolean> {
  const enabled: Record<string, boolean> = {};
  for (const tool of NATIVE_TOOL_CATALOG) enabled[tool.name] = tool.defaultEnabled;
  return enabled;
}

export function normalizeNativeToolEnabled(raw: unknown): Record<string, boolean> {
  const defaults = defaultNativeToolEnabled();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaults;
  const input = raw as Record<string, unknown>;
  for (const tool of NATIVE_TOOL_CATALOG) {
    if (tool.protected) {
      defaults[tool.name] = true;
    } else if (Object.prototype.hasOwnProperty.call(input, tool.name)) {
      defaults[tool.name] = input[tool.name] !== false;
    }
  }
  return defaults;
}

export function nativeToolCatalogForState(enabled?: Record<string, boolean>): Array<NativeToolCatalogEntry & { enabled: boolean }> {
  const resolved = normalizeNativeToolEnabled(enabled || {});
  return NATIVE_TOOL_CATALOG.map(tool => ({ ...tool, enabled: resolved[tool.name] !== false || !!tool.protected }));
}

export function isNativeToolEnabled(name: string, enabled?: Record<string, boolean>): boolean {
  const tool = NATIVE_TOOL_CATALOG.find(entry => entry.name === name);
  if (!tool) return true;
  if (tool.protected) return true;
  return normalizeNativeToolEnabled(enabled || {})[name] !== false;
}
