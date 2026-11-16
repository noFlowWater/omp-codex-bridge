# Changelog

## 0.3.0

- Preserve numeric native JSON-RPC error codes in direct-tool responses.
- Show bounded failed-command output tails, structured plans and effective execution context.
- Keep the latest activity visible after the append-only progress log reaches its limit, with an explicit truncation notice.
- Add read-only connection diagnostics, native thread history search and selected-thread inspection.
- Show native file-change kinds and rename destinations, with bounded diff details on explicit request.
- Keep authentication, routing and permission settings unchanged. Inspection does not adopt, resume or replay a thread.

The bridge still requests workspace-write with cwd-only writable roots, network off and approvals never. Codex trusted rules, MCP/apps and hooks retain their own execution scope.
