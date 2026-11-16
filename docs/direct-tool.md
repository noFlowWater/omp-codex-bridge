# Direct tool and native history

[Home](../README.md) · [Agent Hub](agent-hub.md)

`codex_bridge` exposes `run`, `fork`, `status`, `cancel` and `shutdown`. Direct-tool threads do not appear in Agent Hub.

```json
{"action":"run","cwd":"/absolute/project","model":"gpt-6.1-sol","prompt":"Inspect the parser without edits."}
```

A successful `run` acknowledges admission. Terminal results arrive as follow-ups. Inspect retained text, events and usage with:

```json
{"action":"status","threadId":"<returned-thread-id>"}
```

Cancellation during admission is checked before submitting a new turn. If a new turn has already been submitted when its caller aborts, the bridge requests interruption; the interruption request alone does not prove native completion. A confirmed submission still returns its thread/turn identity, with any interruption failure in the snapshot, so cancellation cannot make accepted input look undelivered. Retained text preserves final answers ahead of partial prose at its size limit and reports when content or message separators exceed that limit.

Continue or cancel a thread owned by the current direct-tool server:

While its turn is running, `run` sends follow-up input with `turn/steer`. Omit `effort`, `outputSchema` and `serviceTier` for that follow-up, even if they match the original request. Those options apply only when starting a new turn after the current turn finishes.

```json
{"action":"run","threadId":"<returned-thread-id>","cwd":"/absolute/project","prompt":"Check the error path next."}
{"action":"cancel","threadId":"<returned-thread-id>"}
```

`status` can inspect saved native history after restart without adopting it. Direct `run` cannot continue threads from another server lifecycle; task agents use their saved lineage for revival.

Fork saved history into a new locally owned direct thread:

```json
{"action":"fork","threadId":"<saved-source-id>","name":"Parser follow-up"}
```

The response returns the new thread ID and continuation arguments. Forking copies through the latest finished turn (`completed`, `failed` or `interrupted`), or the explicit finished `lastTurnId`; it starts no inference and preserves source history and cwd. Optional naming errors appear as `nameWarning` alongside the successful admission.

## Inspect and diagnose

Use OMP's `/codex` command without starting model work:

```text
/codex doctor
/codex doctor --json
/codex status
/codex status --json THREAD_ID
/codex history {"limit":10,"searchTerm":"parser"}
/codex show THREAD_ID
/codex show THREAD_ID {"includeDiff":true,"limit":10}
/codex history --json {"limit":10}
/codex fork THREAD_ID
/codex tier
```

`doctor` reports native connection, authentication availability, model catalog, supported quota information and readable OMP routing settings. Unavailable checks are labelled; credentials and account identifiers are not displayed. It never logs in, changes settings or consumes credits.

`/codex` shows a command/purpose table. Interactive command results, direct-tool results and asynchronous completion notices share OMP's native cards. Answers and failure logs retain their line breaks; truncated native evidence is labelled. Requested diffs use OMP's highlighted diff blocks without requiring JSON mode. Internal flags, model catalogs and pagination data stay out of the default view. Expand the message to see the original JSON, or put `--json` immediately after the subcommand to keep the raw view. Headless output and model-facing message content retain the original structured response. The configured model describes native configuration; it does not prove the effective model of a future run.

The presentation follows [GitHub CLI's human-readable output and explicit JSON mode](https://cli.github.com/manual/gh_help_formatting). [Ink](https://github.com/vadimdemedes/ink) provides a React terminal renderer; [Lip Gloss](https://github.com/charmbracelet/lipgloss) provides Go terminal styling. This extension reuses OMP's `CustomMessageComponent`: the same themed message frame and native Markdown tables used by default messages. Command help is a command/purpose table; summaries use item/value tables. Doctor hides successful auxiliary checks while retaining unavailable checks and quota warnings. Native response data remains separate from its display summary.

Interactive `history` opens a paged native OMP picker with source name and cwd. Choose details or explicitly confirm a fork into a new direct-tool thread. Headless `history`, `history --json` and direct-tool history return JSON.

History choices show a shortened name and directory. Selecting one shows its full thread ID and directory before any fork confirmation. Doctor names quota windows by their reported duration and displays reset times in the host's local time zone; missing durations use neutral window numbers. A successful account read is displayed separately from whether the account is signed in.

`history` supports `cursor`, `limit`, `searchTerm` and `cwd`. `show` supports `includeItems`, `turnId`, `cursor`, `limit` and `includeDiff`. When paging items, retain the returned `turnId` alongside its next cursor. Use small item pages for readable diffs. Inspection does not adopt or resume threads. File changes describe native-reported edits, including rename destinations; shell or generator edits may be absent. Diff content is bounded and returned only when requested. ID-free `status` lists locally loaded direct-tool threads; use history or an explicit thread ID for other saved work.

The direct tool exposes the same operations:

```json
{"action":"diagnose"}
{"action":"history","limit":10,"searchTerm":"parser"}
{"action":"details","threadId":"THREAD_ID","includeDiff":true,"limit":10}
```
