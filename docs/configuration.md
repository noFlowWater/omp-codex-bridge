# Configuration and security

[Home](../README.md) · [Installation](installation.md)

Workers inherit Codex's native filesystem, network and approval settings. The default cwd is the parent session's directory; cwd does not define which files the task authorizes editing. Specify the permitted output paths in the task.

Native approval requests use OMP's approval dialog when available. The complete expandable view retains every request field, including additional permissions and network scope. Older hosts use a selector with a full-details action. Only explicit approval of this one request grants it; dismissal, cancellation, session-wide answers and unavailable UI deny it. No remembered or session-wide permission is created by the bridge.

Configure optional access in `~/.codex/config.toml`, for example:

```toml
sandbox_mode = "workspace-write"
approval_policy = "on-request"

[sandbox_workspace_write]
writable_roots = ["/absolute/path/to/intent"]
```

This keeps the parent cwd while allowing the intent directory. `danger-full-access` is an explicit native option; it removes sandbox restrictions beyond the project. Trusted rules, MCP/apps and hooks retain their native scope. Review configuration before running untrusted work.

The app-server inherits the parent process environment, including configured provider credentials, proxy and MCP variables. Native Codex settings govern which variables its shell tools inherit. The standalone client's optional `env` map overrides individual variables; `null` or `undefined` removes one.

For bridge-only overrides, set a native JSON configuration map before starting OMP:

```sh
export OMP_CODEX_BRIDGE_CONFIG='{"sandbox_mode":"workspace-write","sandbox_workspace_write.writable_roots":["/absolute/path/to/intent"]}'
```

These keys go directly to app-server's thread configuration API; Codex validates them. No config file is modified. Changing bridge overrides requires a fresh task; existing fixed-policy task records also require a fresh task.

Delivery receipts live in `codex-bridge-state` under OMP's agent directory. Set `OMP_CODEX_BRIDGE_STATE_DIR` to override it. State is kept outside this checkout; native history remains under Codex's own storage. Do not publish either location or delete receipts for active tasks.

The repository contains no authentication, sessions, model cache or user configuration. Installing it does not change Codex configuration.
