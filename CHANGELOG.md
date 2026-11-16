# Changelog

## 0.4.0

- Inherit native Codex permissions and approval policy instead of forcing cwd-only workspace-write.
- Allow optional native configuration overrides without changing Codex's configuration files.
- Route supported native approval requests to explicit user confirmation.
- Replace multiline activity widgets with a compact native OMP footer; keep worker detail in Agent Hub and status inspection.
- Preserve native provider credentials, proxy and MCP environment variables when starting app-server.
- Register lifecycle-opened clients for OMP teardown and close temporary clients after `/clear`, including failed resets.

Migration: restart OMP and start fresh tasks for records created under the previous fixed permission policy. Workers now inherit native Codex permissions and the parent environment; review those settings before delegation. `OMP_CODEX_BRIDGE_CONFIG` supplies optional bridge-only native overrides.

## 0.3.0

- Preserve numeric native JSON-RPC error codes in direct-tool responses.
- Show bounded failed-command output tails, structured plans and effective execution context.
- Keep the latest activity visible after the append-only progress log reaches its limit, with an explicit truncation notice.
- Add read-only connection diagnostics, native thread history search and selected-thread inspection.
- Show native file-change kinds and rename destinations, with bounded diff details on explicit request.
- Keep authentication, routing and permission settings unchanged. Inspection does not adopt, resume or replay a thread.

The bridge still requests workspace-write with cwd-only writable roots, network off and approvals never. Codex trusted rules, MCP/apps and hooks retain their own execution scope.
