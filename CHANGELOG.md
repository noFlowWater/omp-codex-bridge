# Changelog

## 0.8.0 — 2026-11-17

- Add `/codex jobs` with native worker selection, details, messages and targeted interruption; retain failed drafts and reject stale turn selections.
- Include current Codex Hub workers when the host exposes `ctx.agents`, with queued cancellation and native Hub focus.
- Continue saved history through a selected finished turn as a fresh Hub child after explicit question submission. Keep source history unchanged, fork context inside its child provider and never replay source transcripts or uncertain forks.
- Page older finished boundaries and separate history selection, worker selection, host controls and durable fork admission into focused modules.
- Ship an optional patch for the pinned OMP 18.21.0 host API; stock hosts retain direct-worker controls and report missing Hub controls explicitly.

## 0.7.0 — 2026-11-17

- Make native `run` start-only and expose explicit direct-tool `steer` with an expected turn ID; active starts never silently become follow-ups.
- Keep inherited turn-start settings out of live messages, retain admission receipts, and distinguish delivery from task completion.

## 0.6.4 — 2026-11-17

- Wait for direct native turns in print text/JSON mode so CLI disposal cannot interrupt a merely admitted task; return terminal output once and forward deadline cancellation.
- Explain that `/codex` commands run in the main session and how to return from a focused Hub child.
- Explain how to fork through a finished turn and use the returned continuation arguments when a direct thread is no longer locally owned.
- Add an executable structured-output example with object-schema constraints and admission/result guidance.

## 0.6.3 — 2026-11-17

- Keep interactive operator payloads in message details and send compact summaries as model context; retain expanded JSON, explicit `--json` and headless structured output.
- Name untitled main conversations after their first user question so diagnostic messages do not dominate native history labels.
- Label every model picker entry `cost unknown` and clarify the host's zero-price placeholders in doctor output.

## 0.6.2 — 2026-11-17

- Resolve the current native turn before rejecting turn-start options on a resumed thread with omitted turns; retain the guard for a confirmed running turn and explain how to send a live follow-up.
- Label an omitted requested effort as the native default rather than unknown; effective effort still requires native evidence.

## 0.6.1 — 2026-11-17

- Honor cancellation while direct/native turn admission is pending; interrupt a newly submitted turn when its caller aborts before the admission reply.
- Keep confirmed input receipts when cancellation follows admission, report interruption refusals separately, and release previous-turn waits and listeners on cancellation.
- Reserve retained-text capacity for final answers and flag truncation caused by combining multiple messages.
- Resolve default model capabilities and reasoning support from effective native configuration; accept model-advertised efforts without a fixed bridge allowlist.
- Preserve valid MCP form answers during field correction and use native multi-select for enumerated arrays, retaining whole-form validation and explicit submission.
- Offer form correction only for input errors; propagate host UI failures to the native error response.
- Separate provider submission, turn observation, steering, progress formatting and form handling. Build cards directly from metadata instead of reparsing padded display strings.

## 0.6.0 — 2026-11-17

- Use the same native cards for direct-tool results and asynchronous completion notices, retaining structured headless responses.
- Preserve multiline answers and failure output, label truncated evidence, and render requested native diffs without requiring JSON mode.
- Prefer OMP's native approval dialog with complete expandable request scope; retain explicit one-request confirmation and fail-closed cancellation.
- Label quota windows by duration, show local reset times and readable login state, and shorten history picker labels while retaining full identity in details.

- Reuse OMP's default themed message cards and native tables for operator output; hide successful auxiliary doctor checks.
- Show multiline `/codex` help and human summaries for errors, saved-thread details, forks and tier results; keep full data in expanded/`--json` views.
- Render compact native OMP summaries for `/codex doctor` and `/codex status`; preserve expanded/raw JSON with `--json` and unchanged headless responses.

- Focus the README on installation and first use; move detailed integration, configuration and development guides into `docs/`.
- Include the documentation guides in the package file list.
- Shorten native model labels; document token usage and billing limits outside the status line.
- Show observed native models in the active footer and retain reported turn tokens with unavailable cost in result cards.
- Distinguish Codex-internal delegation from OMP Agent Hub workers and keep token updates out of the activity transcript.

## 0.5.1

- Fork the latest completed, failed or interrupted native turn instead of skipping failure context or rejecting it.
- Keep running and unknown boundaries out of explicit forks; source history remains unchanged.
- Pin CI to OMP 18.21.0 with the official release asset checksum.

## 0.5.0

- Synchronize OMP task/session names to native threads without blocking task execution on title failures.
- Add a paged history picker and explicitly confirmed native forks into new direct-tool threads.
- Retain headless history JSON and add `history --json` for interactive sessions.
- Report native quota exhaustion and observed recovery once across concurrent clients, preserving sparse updates.
- Add per-turn native `serviceTier` and `/codex tier` using OMP's existing session OpenAI-family setting.
- Separate requested processing tier from effective tier, which remains unknown when native responses omit it.

Restart OMP to load the update. Saved v0.4.0 delivery receipts remain valid. A history fork starts no inference and stays outside Agent Hub; continue the returned new thread through `codex_bridge run`.

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
