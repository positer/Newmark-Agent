"use strict";

const navigation = [
  { id: "home", icon: "[O]", label: "Overview", section: "root" },
  { id: "chat", icon: "[C]", label: "Conversations", section: "workspace" },
  { id: "plan", icon: "[P]", label: "Plan", section: "workspace" },
  { id: "goal", icon: "[G]", label: "Goal", section: "workspace" },
  { id: "agents", icon: "[A]", label: "Subagents", section: "workspace" },
  { id: "model", icon: "[L]", label: "Model", section: "workspace" },
  { id: "flowbar", icon: "[B]", label: "Flow Bar", section: "workspace" },
  { id: "flowlist", icon: "[F]", label: "Flow List", section: "workspace" },
  { id: "flowtask", icon: "[K]", label: "Flow Task", section: "workspace" },
  { id: "tools", icon: "[T]", label: "Tools", section: "operations" },
  { id: "memory", icon: "[M]", label: "Memory Lab", section: "operations" },
  { id: "automation", icon: "[R]", label: "Automations", section: "operations" },
  { id: "settings", icon: "[S]", label: "Settings", section: "operations" },
  { id: "help", icon: "[H]", label: "Help", section: "operations" }
];

const workspace = {
  id: "workspace-newmark-agent-demo",
  name: "Newmark Agent",
  path: "C:\\Users\\12252\\Desktop\\Files\\Code\\Newmark Agent",
  isInternal: false,
  hostBinding: "demo-host",
  icon: "[W]",
  kind: "local",
  status: "active"
};

const conversations = [
  { id: "release-readiness-review", key: "demo:release-readiness-review", title: "Release readiness review", messageCount: 12, historyCount: 18, updatedAt: "2026-07-28T17:28:00+08:00", pinned: true, pinnedAt: "2026-07-28T16:00:00+08:00", order: 0 },
  { id: "memory-lab-performance", key: "demo:memory-lab-performance", title: "Memory Lab performance", messageCount: 24, historyCount: 38, updatedAt: "2026-07-28T16:56:00+08:00", pinned: false, pinnedAt: "", order: 1 },
  { id: "provider-routing-audit", key: "demo:provider-routing-audit", title: "Provider routing audit", messageCount: 9, historyCount: 14, updatedAt: "2026-07-28T15:30:00+08:00", pinned: false, pinnedAt: "", order: 2 },
  { id: "linux-packaging-notes", key: "demo:linux-packaging-notes", title: "Linux packaging notes", messageCount: 7, historyCount: 11, updatedAt: "2026-07-27T17:30:00+08:00", pinned: false, pinnedAt: "", order: 3 }
];

const workspaces = [
  workspace,
  {
    id: "workspace-condensed-lab-demo",
    name: "Condensed Lab",
    path: "C:\\Users\\12252\\Desktop\\Files\\Condensed Lab",
    isInternal: false,
    hostBinding: "demo-host",
    icon: "[W]",
    kind: "local",
    status: "active"
  },
  {
    id: "workspace-push-lite-demo",
    name: "push-lite",
    path: "/srv/newmark",
    isInternal: false,
    hostBinding: "demo-host",
    icon: "[R]",
    kind: "ssh",
    remoteUserHost: "newmark@push-lite",
    status: "connected"
  }
];

const workspaceConversations = {
  [workspace.id]: conversations,
  "workspace-condensed-lab-demo": [
    { id: "arc-literature-boundary", key: "demo:arc-literature-boundary", title: "ARC literature boundary", messageCount: 18, historyCount: 27, updatedAt: "2026-07-28T16:42:00+08:00", pinned: true, pinnedAt: "2026-07-28T12:00:00+08:00", order: 0 },
    { id: "selector-simulation-campaign", key: "demo:selector-simulation-campaign", title: "Selector simulation campaign", messageCount: 31, historyCount: 49, updatedAt: "2026-07-28T14:10:00+08:00", pinned: false, pinnedAt: "", order: 1 },
    { id: "completion-audit", key: "demo:completion-audit", title: "Completion audit", messageCount: 14, historyCount: 22, updatedAt: "2026-07-27T21:05:00+08:00", pinned: false, pinnedAt: "", order: 2 }
  ],
  "workspace-push-lite-demo": [
    { id: "ssh-runtime-health", key: "demo:ssh-runtime-health", title: "SSH runtime health", messageCount: 10, historyCount: 16, updatedAt: "2026-07-28T17:05:00+08:00", pinned: true, pinnedAt: "2026-07-28T15:00:00+08:00", order: 0 },
    { id: "remote-release-deploy", key: "demo:remote-release-deploy", title: "Remote release deploy", messageCount: 22, historyCount: 35, updatedAt: "2026-07-28T13:25:00+08:00", pinned: false, pinnedAt: "", order: 1 }
  ]
};

const conversationScenarios = {
  "release-readiness-review": {
    goal: "Publish a verified prerelease with matching remote hashes",
    plan: ["Inspect current package state", "Run source regression gate", "Validate packaged Windows build", "Validate packaged Linux build", "Publish prerelease and audit hashes"],
    agents: [["release-audit", "Checking packaged artifacts", "working"], ["linux-smoke", "Waiting for package output", "queued"], ["docs-review", "README consistency review", "completed"]]
  },
  "memory-lab-performance": {
    goal: "Keep 300-component query P95 below 15 ms",
    plan: ["Capture baseline query latency", "Profile repeated component reads", "Verify retained snapshot cache", "Run 600-query stress gate"],
    agents: [["query-profiler", "Sampling cache latency", "working"], ["graph-audit", "Checking retained DOM behavior", "completed"]]
  },
  "provider-routing-audit": {
    goal: "Prove Auto routing preserves provider identity and policy",
    plan: ["Enumerate validated deployments", "Review route scoring inputs", "Exercise provider fallback", "Audit redacted decisions"],
    agents: [["route-matrix", "Testing deployment selection", "working"], ["privacy-review", "Auditing decision records", "queued"]]
  },
  "linux-packaging-notes": {
    goal: "Make every Linux package launch the same executable",
    plan: ["Inspect unpacked filenames", "Check AppImage entrypoint", "Check deb desktop file", "Document accepted executable aliases"],
    agents: [["appimage-smoke", "Launching AppImage payload", "completed"], ["deb-inspector", "Reading package metadata", "working"]]
  },
  "arc-literature-boundary": {
    goal: "Block duplicate ARC directions before simulation",
    plan: ["Define search vocabulary", "Scan primary literature", "Map nearest prior methods", "Record novelty boundary"],
    agents: [["literature-scan", "Reviewing primary papers", "working"], ["novelty-critic", "Comparing claimed directions", "queued"], ["citation-audit", "Checking source coverage", "completed"]]
  },
  "selector-simulation-campaign": {
    goal: "Complete the automatic selector campaign with reproducible evidence",
    plan: ["Load approved selector set", "Run baseline simulations", "Launch remaining directions", "Aggregate observables", "Review failed seeds"],
    agents: [["campaign-east", "Running direction batch east", "working"], ["campaign-west", "Running direction batch west", "working"], ["seed-repair", "Retrying failed seeds", "queued"]]
  },
  "completion-audit": {
    goal: "Prove campaign completion against current files",
    plan: ["Inventory expected outputs", "Validate machine-readable manifests", "Cross-check review records", "Issue closure report"],
    agents: [["manifest-audit", "Checking output manifests", "completed"], ["closure-review", "Reviewing acceptance evidence", "working"]]
  },
  "ssh-runtime-health": {
    goal: "Keep the remote Newmark runtime reachable and observable",
    plan: ["Check SSH reachability", "Inspect remote process state", "Verify workspace binding", "Review reconnect behavior"],
    agents: [["ssh-probe", "Checking port and handshake", "completed"], ["runtime-watch", "Watching remote lifecycle", "working"]]
  },
  "remote-release-deploy": {
    goal: "Deploy the verified release to push-lite without service interruption",
    plan: ["Verify remote free space", "Upload signed manifest", "Stage release payload", "Switch active version", "Run remote smoke"],
    agents: [["upload-worker", "Transferring release payload", "working"], ["remote-smoke", "Waiting for version switch", "queued"], ["rollback-guard", "Preparing recovery pointer", "completed"]]
  }
};

const messages = [
  { messageId: "msg-user-1", role: "user", content: "Review the current release gate and call out anything still blocking.", mode: "build", model: "auto", timestamp: "2026-07-28T17:25:00+08:00" },
  {
    messageId: "msg-assistant-1",
    role: "assistant",
    content: "The demo release gate is healthy. Source checks, package smoke, and policy audit all pass. I would still verify the Linux executable name before publishing.",
    mode: "build",
    model: "auto",
    timestamp: "2026-07-28T17:25:02+08:00",
    meta: "Balanced · 1.8s · 246 tokens"
  }
];

const planItems = [
  { id: "plan-1", text: "Inspect current package state", status: "done", updatedAt: "2026-07-28T17:02:00+08:00" },
  { id: "plan-2", text: "Run source regression gate", status: "done", updatedAt: "2026-07-28T17:08:00+08:00" },
  { id: "plan-3", text: "Validate packaged Windows build", status: "in_progress", updatedAt: "2026-07-28T17:20:00+08:00" },
  { id: "plan-4", text: "Validate packaged Linux build", status: "pending", updatedAt: "2026-07-28T17:20:00+08:00" },
  { id: "plan-5", text: "Publish prerelease and audit hashes", status: "pending", updatedAt: "2026-07-28T17:20:00+08:00" }
];

const agents = [
  { id: "agent-release-audit", shortId: "rel-aud", natureSlug: "release-audit", displayName: "release-audit", qualifiedName: "root/release-audit", name: "release-audit", createdByAgentId: "root", prompt: "Check packaged artifacts", model: "auto", inputMode: "next", agentMode: "build", status: "working", messages: [], result: null, createdAt: "2026-07-28T17:20:00+08:00", updatedAt: "2026-07-28T17:27:00+08:00", active: true, mode: "build", mailbox: { unread: 0, total: 1 }, task: "Checking packaged artifacts", progress: 68 },
  { id: "agent-linux-smoke", shortId: "lin-smk", natureSlug: "linux-smoke", displayName: "linux-smoke", qualifiedName: "root/linux-smoke", name: "linux-smoke", createdByAgentId: "root", prompt: "Run Linux smoke after package output", model: "auto", inputMode: "next", agentMode: "build", status: "queued", queueSequence: 2, messages: [], result: null, createdAt: "2026-07-28T17:21:00+08:00", updatedAt: "2026-07-28T17:21:00+08:00", active: true, mode: "build", mailbox: { unread: 0, total: 0 }, task: "Waiting for package output", progress: 0 },
  { id: "agent-docs-review", shortId: "doc-rev", natureSlug: "docs-review", displayName: "docs-review", qualifiedName: "root/docs-review", name: "docs-review", createdByAgentId: "root", prompt: "Review README consistency", model: "auto", inputMode: "next", agentMode: "build", status: "completed", messages: [], result: "No blocking inconsistencies.", createdAt: "2026-07-28T17:05:00+08:00", updatedAt: "2026-07-28T17:16:00+08:00", completedAt: "2026-07-28T17:16:00+08:00", active: true, mode: "build", mailbox: { unread: 1, total: 2 }, task: "README consistency review", progress: 100 }
];

const workRuns = [{
  runId: "run-release-review",
  target: { workspaceId: workspace.id, conversationId: conversations[0].id },
  runtimeKey: `${workspace.id}::${conversations[0].id}`,
  status: "completed",
  startedAt: "2026-07-28T17:25:00+08:00",
  endedAt: "2026-07-28T17:25:02+08:00",
  expanded: false,
  sequence: 1,
  events: [
    { id: "event-tool-1", conversationId: conversations[0].id, type: "tool_call", content: "npm test", mode: "build", model: "auto", timestamp: "2026-07-28T17:25:01+08:00", toolName: "bash" },
    { id: "event-tool-2", conversationId: conversations[0].id, type: "tool_result", content: "979 assertions passed", mode: "build", model: "auto", timestamp: "2026-07-28T17:25:01+08:00", toolName: "bash" }
  ],
  guides: []
}];

const providers = [
  {
    id: "provider-openai-hub",
    name: "OpenAI Hub",
    base_url: "https://api.example.com/v1",
    api_key: "",
    has_api_key: true,
    protocol: "openai",
    enabled: true,
    models: [
      { name: "gpt-5.6", display: "GPT-5.6", description: "Primary coding and reasoning model", max_tokens: 128000, vision: true, thinking: true, enabled: true, speed_rating: "fast", capability_rating: "extended", validation: { status: "verified", level: "extended", checked_at: "2026-07-28T16:40:00+08:00", latency_ms: 842 } },
      { name: "gpt-5.6-mini", display: "GPT-5.6 Mini", description: "Low-latency utility model", max_tokens: 128000, vision: true, thinking: false, enabled: true, speed_rating: "very_fast", capability_rating: "standard", validation: { status: "verified", level: "standard", checked_at: "2026-07-28T16:42:00+08:00", latency_ms: 391 } }
    ]
  },
  {
    id: "provider-anthropic-lab",
    name: "Anthropic Lab",
    base_url: "https://anthropic.example.com",
    api_key: "",
    has_api_key: true,
    protocol: "anthropic",
    enabled: true,
    models: [
      { name: "claude-opus-demo", display: "Claude Opus Demo", description: "Long-context review model", max_tokens: 200000, vision: true, thinking: true, enabled: true, speed_rating: "medium", capability_rating: "standard", validation: { status: "degraded", level: "standard", checked_at: "2026-07-28T16:48:00+08:00", latency_ms: 1334 } }
    ]
  },
  {
    id: "provider-github-models",
    name: "GitHub Models",
    base_url: "https://models.github.ai/inference",
    api_key: "",
    has_api_key: false,
    protocol: "github_models",
    enabled: false,
    models: [
      { name: "github-model-demo", display: "GitHub Model Demo", description: "Disabled provider example", max_tokens: 64000, vision: false, thinking: false, enabled: true, speed_rating: "unknown", capability_rating: "discovered", validation: { status: "unavailable", level: "discovered", checked_at: "2026-07-28T16:50:00+08:00" } }
    ]
  }
];

const flows = [
  {
    name: "release-readiness",
    components: [
      { id: 1, type: "dialog", mode: "plan", prompt: "Audit release scope and gates." },
      { id: 2, type: "dialog", mode: "build", prompt: "Run package and shared-backend verification." },
      { id: 3, type: "logic", prompt: "Did every gate pass?", goto_true: 4, goto_false: 2 },
      { id: 4, type: "dialog", mode: "goal", prompt: "Close the release objective with evidence." }
    ]
  },
  {
    name: "conversation-recovery",
    components: [
      { id: 1, type: "dialog", mode: "build", prompt: "Reproduce the conversation-state defect." },
      { id: 2, type: "dialog", mode: "plan", prompt: "Review persistence and isolation evidence." },
      { id: 3, type: "dialog", mode: "build", prompt: "Apply and verify the focused repair." }
    ]
  }
];

const memoryLab = {
  ok: true,
  root: "~/.Newmark/Memory Lab",
  indexPath: "~/.Newmark/Memory Lab/index.json",
  componentsDir: "~/.Newmark/Memory Lab/components",
  instructions: "Mock visualization aligned with MemoryLabVisualizationResult.",
  relationVersion: "demo-relation-v3",
  loadedAt: "2026-07-28T17:30:00+08:00",
  index: {
    version: 2,
    updatedAt: "2026-07-28T17:28:00+08:00",
    preferredLanguage: "zh",
    tags: {
      newmark: { parents: [], children: ["runtime", "release"], components: ["newmark-runtime-root", "release-gates"], aliases: ["agent"] },
      runtime: { parents: ["newmark"], children: ["wsl"], components: ["newmark-runtime-root", "conversation-kernel"], aliases: [] },
      wsl: { parents: ["runtime"], children: [], components: ["wsl-baseline"], aliases: ["ubuntu"] },
      release: { parents: ["newmark"], children: [], components: ["release-gates"], aliases: ["packaging"] },
      research: { parents: [], children: ["arc"], components: ["research-closure"], aliases: [] },
      arc: { parents: ["research"], children: [], components: ["arc-literature-boundary", "research-closure"], aliases: [] }
    },
    components: {
      "newmark-runtime-root": { name: "Newmark runtime root", description: "Install-independent mutable state policy.", tags: ["newmark", "runtime"], tagPaths: [["newmark", "runtime"]], path: "components/newmark-runtime-root.md", coreMd: "components/newmark-runtime-root.md", kind: "file", createdAt: "2026-07-03T09:00:00+08:00", updatedAt: "2026-07-28T15:00:00+08:00", revision: 6 },
      "conversation-kernel": { name: "Conversation kernel", description: "Workspace and conversation runtime isolation.", tags: ["runtime"], tagPaths: [["newmark", "runtime"]], path: "components/conversation-kernel.md", coreMd: "components/conversation-kernel.md", kind: "file", createdAt: "2026-07-20T10:00:00+08:00", updatedAt: "2026-07-28T16:00:00+08:00", revision: 4 },
      "wsl-baseline": { name: "WSL baseline", description: "Ubuntu runtime setup and shell verification.", tags: ["wsl"], tagPaths: [["newmark", "runtime", "wsl"]], path: "components/wsl-baseline.md", coreMd: "components/wsl-baseline.md", kind: "file", createdAt: "2026-07-10T10:00:00+08:00", updatedAt: "2026-07-25T12:00:00+08:00", revision: 3 },
      "release-gates": { name: "Release gates", description: "Source, package, publish, and hash audit gates.", tags: ["newmark", "release"], tagPaths: [["newmark", "release"]], path: "components/release-gates.md", coreMd: "components/release-gates.md", kind: "file", createdAt: "2026-07-03T12:00:00+08:00", updatedAt: "2026-07-28T17:00:00+08:00", revision: 8 },
      "arc-literature-boundary": { name: "ARC literature boundary", description: "Literature-first novelty boundary.", tags: ["arc"], tagPaths: [["research", "arc"]], path: "components/arc-literature-boundary.md", coreMd: "components/arc-literature-boundary.md", kind: "file", createdAt: "2026-06-20T08:00:00+08:00", updatedAt: "2026-07-22T11:00:00+08:00", revision: 5 },
      "research-closure": { name: "Research closure", description: "Machine-readable completion evidence.", tags: ["research", "arc"], tagPaths: [["research", "arc"]], path: "components/research-closure.md", coreMd: "components/research-closure.md", kind: "file", createdAt: "2026-06-21T08:00:00+08:00", updatedAt: "2026-07-24T11:00:00+08:00", revision: 7 }
    }
  },
  componentContents: {
    "newmark-runtime-root": "# Newmark runtime root\n\nMutable settings and state resolve under `~/.Newmark`, independent of the installation directory.",
    "conversation-kernel": "# Conversation kernel\n\nEvery runtime is bound to an explicit workspace and conversation target.",
    "wsl-baseline": "# WSL baseline\n\nUbuntu 24.04 provides the verified shell and build baseline.",
    "release-gates": "# Release gates\n\nValidate source, packaged artifacts, publication, and remote hashes in order.",
    "arc-literature-boundary": "# ARC literature boundary\n\nLiterature review blocks duplicate simulation directions.",
    "research-closure": "# Research closure\n\nClose work only after current files pass a machine-readable audit."
  }
};

const tools = [
  { name: "terminal", group: "Local", enabled: true, calls: 28 },
  { name: "files", group: "Local", enabled: true, calls: 47 },
  { name: "browser", group: "Built-in", enabled: true, calls: 6 },
  { name: "computer_use", group: "Built-in", enabled: false, calls: 0 },
  { name: "github", group: "Connector", enabled: true, calls: 3 },
  { name: "ssh", group: "Remote", enabled: false, calls: 0 }
];

const automations = [
  { name: "Nightly regression", schedule: "Daily · 02:00", enabled: true, last: "passed" },
  { name: "Release asset audit", schedule: "On release", enabled: true, last: "passed" },
  { name: "Workspace archive", schedule: "Fri · 18:00", enabled: false, last: "paused" }
];

const commands = [
  { label: "Go to Overview", hint: "1", action: "view:home" },
  { label: "Open Conversations", hint: "2", action: "view:chat" },
  { label: "Open Plans & goals", hint: "3", action: "view:plan" },
  { label: "Open Subagents", hint: "4", action: "view:agents" },
  { label: "Open Tools", hint: "5", action: "view:tools" },
  { label: "Open Memory Lab", hint: "6", action: "view:memory" },
  { label: "Open Automations", hint: "7", action: "view:automation" },
  { label: "Open Settings", hint: "8", action: "view:settings" },
  { label: "New conversation", hint: "N", action: "new-chat" },
  { label: "Toggle theme", hint: "T", action: "theme" },
  { label: "Keyboard shortcuts", hint: "?", action: "help" }
];

module.exports = {
  agents,
  automations,
  commands,
  conversations,
  conversationScenarios,
  flows,
  messages,
  navigation,
  planItems,
  providers,
  memoryLab,
  workspace,
  workspaceConversations,
  workspaces,
  workRuns,
  tools
};
