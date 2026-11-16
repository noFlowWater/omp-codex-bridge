---
name: codex-bridge
description: Codex native worker visible in Agent Hub, for review or editing. Delegates to local Codex app-server and its own model/tools. Requests workspace-write shell/file sandbox settings with task-cwd writable roots, networkAccess false, /tmp and $TMPDIR excluded, approvalPolicy never. Trusted Codex allow rules, MCP servers, apps and hooks follow Codex configuration; these settings are not a complete process/network boundary. Use the parent's cwd; do not request isolation or create a worktree unless asked. Without a task model, runs Codex's configured default (codex-bridge/default). Listed codex-bridge/<native-model> selectors require OMP's per-call model setting and stay fixed for the child's lifetime. Watch, message or kill in Agent Hub (Alt+A). Running-turn messages need providers.openaiLiveSteering; otherwise they become the next native turn. Blocking questions use the current main session's UI; headless runs cannot answer them.
# First entry runs by default (Codex config default model). The rest grant exact per-call selectors for the
# native models Codex's model/list reported; add a line here when Codex adds a model.
model:
  - codex-bridge/default
  - codex-bridge/gpt-6.1-sol
  - codex-bridge/gpt-6-astra
  - codex-bridge/gpt-6.1-terra
  - codex-bridge/gpt-6-sol
  - codex-bridge/gpt-6-luna
  - codex-bridge/gpt-5.6-sol
  - codex-bridge/gpt-5.6-terra
  - codex-bridge/gpt-5.6-luna
tools: []
---

This agent runs through the native Codex app-server and the `codex-bridge` provider. Codex owns inference, native tools and persisted threads; OMP shows progress and answers. The adapter requests workspace-write shell/file sandbox settings limited to the task cwd, networkAccess false, excluded temp directories and approvalPolicy never. Codex trusted allow rules, MCP servers, apps and hooks retain their configured behavior. OMP thinking levels map to native reasoning effort; when no effort is supplied, Codex keeps its configured default.
