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

Continue or cancel a thread owned by the current direct-tool server:

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
/codex status
/codex history {"limit":10,"searchTerm":"parser"}
/codex show THREAD_ID
/codex show THREAD_ID {"includeDiff":true,"limit":10}
/codex history --json {"limit":10}
/codex fork THREAD_ID
/codex tier
```

`doctor` reports native connection, authentication availability, model catalog, supported quota information and readable OMP routing settings. Unavailable checks are labelled; credentials and account identifiers are not displayed. It never logs in, changes settings or consumes credits.

Interactive `history` opens a paged native OMP picker with source name and cwd. Choose details or explicitly confirm a fork into a new direct-tool thread. Headless `history`, `history --json` and direct-tool history return JSON.

`history` supports `cursor`, `limit`, `searchTerm` and `cwd`. `show` supports `includeItems`, `turnId`, `cursor`, `limit` and `includeDiff`. When paging items, retain the returned `turnId` alongside its next cursor. Use small item pages for readable diffs. Inspection does not adopt or resume threads. File changes describe native-reported edits, including rename destinations; shell or generator edits may be absent. Diff content is bounded and returned only when requested. ID-free `status` lists locally loaded direct-tool threads; use history or an explicit thread ID for other saved work.

The direct tool exposes the same operations:

```json
{"action":"diagnose"}
{"action":"history","limit":10,"searchTerm":"parser"}
{"action":"details","threadId":"THREAD_ID","includeDiff":true,"limit":10}
```
