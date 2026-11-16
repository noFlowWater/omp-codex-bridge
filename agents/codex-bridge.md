---
name: codex-bridge
description: Codex native worker visible in Agent Hub, for review or editing. Delegates to local Codex app-server with its configured tools, permissions and approval policy. Optional operator configuration overrides native settings. Use the parent's cwd unless asked otherwise; respect the task's allowed edit paths. Without a task model, runs Codex's configured default (codex-bridge/default). Listed codex-bridge/<native-model> selectors require OMP's per-call model setting and stay fixed for the child's lifetime. Watch, message or kill in Agent Hub (Alt+A). Running-turn messages need providers.openaiLiveSteering; otherwise they become the next native turn. Blocking questions and supported approvals use the main session's UI; headless requests are declined.
# Native package installation discovers this agent at user scope; no separate user agent link is needed.
# First entry routes to Codex's configured default. Remaining exact selectors grant per-call choices
# only when the operator enables task.perCallModel. This list is a reviewed model-discovery snapshot.
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

This agent runs through the native Codex app-server and the `codex-bridge` provider. Codex owns inference, native tools and persisted threads; OMP shows progress and answers. Native Codex configuration determines filesystem access, network access and approval policy. The task's allowed edit paths remain binding regardless of sandbox access. OMP thinking levels map to native reasoning effort; when no effort is supplied, Codex keeps its configured default.
