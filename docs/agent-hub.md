# Agent Hub

[Home](../README.md) · [Configuration](configuration.md)

Ask the main assistant to delegate to `codex-bridge`, or use the task tool:

```json
{"context":"Parser review","tasks":[{"name":"ParserReview","agent":"codex-bridge","task":"Review the parser without editing files.","solutionSpace":"Read-only review of parser correctness"}]}
```

Open Agent Hub with `Alt+A` or double left-arrow on an empty editor. Focus the child to inspect its progress and send messages; Hub `x` interrupts it. A follow-up to the same child continues its native thread.

OMP task/session names are copied to native thread names on the next request. Child task identity supplies the name when no session title exists. Naming is metadata-only; a title failure does not replay or reject task input.

Running-turn steering requires OMP's `providers.openaiLiveSteering` setting. With it disabled, a message is queued for the next native turn. Installation does not enable this setting.

### Model selection

`codex-bridge/default` uses Codex's configured default model. Explicit profiles use `codex-bridge/<native-model>`, for example `codex-bridge/gpt-6.1-sol`.

Per-task selection requires the operator's `task.perCallModel: on` and a matching exact selector in the installed agent's frontmatter. A configured `task.perCallModelAllow` further narrows that grant. Project agents and model discovery do not grant permission. A `task.agentModelOverrides` entry for this agent conflicts with a per-call `model`. Installation changes none of these settings. A child's model stays fixed for its lifetime; start a new child to change it.

The shipped native selectors are a compatibility snapshot, not a promise that every account exposes them. Use `codex-bridge/default` for Codex's configured model. Add new exact selectors to an operator-owned agent definition only after reviewing native model discovery; wildcard model entries do not grant per-call permission.

### Processing tier

Use `/codex tier` for a picker or `/codex tier priority` to change OMP's existing OpenAI-family setting for this session. `/codex tier inherit` clears that override. Hub requests use the selected tier for each new native turn; `auto` and omitted selections preserve Codex defaults. This setting also applies to other OpenAI-family models in the same OMP session.

Direct calls can set `"serviceTier":"fast"` or another native tier per `run`; omission inherits native configuration. Availability depends on Codex and the account. Requests use native `serviceTierForTurn`, leaving the thread's future default unchanged. Cards distinguish requested tier from effective tier; an unreported effective tier stays unknown.

Tier selection can change quota consumption or charges. The bridge does not estimate subscription cost.

## Progress and usage

The native OMP footer shows `Codex N active · MODEL · Alt+A` when one observed model is available, or a model count for mixed workers. Agent Hub owns per-worker progress. Execution context, activity and plans remain in the child's transcript and `codex_bridge status`, including updates beyond the transcript log cap. Failed-command output tails can contain sensitive application output; longer command output and file diffs are not automatically dumped.

`Codex internal delegation` identifies child activity inside Codex, separate from OMP Hub workers. The transcript shows observed child status and suppresses repeated token-context updates; native usage remains available in status and OMP usage counters.

Native quota events generate one warning on exhaustion and an informational notice on observed recovery, shared across concurrent workers. Reset times appear when reported. Sparse or unavailable fields do not imply recovery; there is no quota polling or automatic retry.

### Tokens and cost

Model labels show only the native provider and selected model. The active footer identifies the model reported by Codex without changing the selected OMP model. Result cards show reported turn tokens with `Cost: not reported`; compact result JSON uses `cost: null`. Missing usage stays unavailable.

The [app-server API](https://learn.chatgpt.com/docs/app-server) reports token usage and account limits, not a per-turn billed amount. Its model catalog does not include prices. OMP's zero-valued price fields are placeholders for unavailable pricing, not a claim that execution is free.

OMP 18.21 requires numeric response costs and does not expose unknown billing through its public provider registration API. Its built-in total therefore cannot represent this missing charge. Use the native account dashboard for billing; the bridge's `cost: null` applies to its own result summaries.

The [official pricing page](https://learn.chatgpt.com/docs/pricing) publishes token-based credit rates and links to API pricing. Those rates can support estimates; included subscription usage, purchased credits, processing tier and plan-specific billing determine the actual charge. Check the native usage dashboard for account usage.

## Inputs and lifecycle

- Text, images, model-supported reasoning effort and object-valued JSON Schema output are forwarded to native APIs. Structured task output is validated before delivery. OMP's `forceReasoningOff` takes precedence over a requested effort.
- Blocking and asynchronous questions use the main OMP UI. Standard and OpenAI extended MCP forms keep valid answers while an invalid field is corrected, offer native multi-select for enumerated arrays, and require complete schema validation plus explicit submission. Headless questions, URL flows and unsupported schemas are declined.
- Native token counters and context-window information are reported. Subscription cost remains unknown.
- Tree navigation, entry branches and whole-session forks preserve the source history and fork native history at the selected completed boundary. Compaction creates an opaque native checkpoint; Codex exposes no readable summary. An incompatible model cannot consume it.
- OMP may refuse compaction of a small local transcript before the native hook runs. Focused compaction instructions and unsupported mid-turn branches are rejected.
- Reload preserves confirmed task lineage. Clear starts a fresh conversation. Unknown mutation outcomes and missing lineage stop processing without replaying work.
- Cancellation releases previous-turn waits without consuming new input. Once native admission is confirmed, cancellation retains the delivery receipt; a later request cannot replay that input. Host UI failures propagate as native request errors instead of prompting the user to correct an answer.
- Malformed successful mutation replies retain an unknown outcome, preventing automatic replay. Failed pre-send cancellation and confirmed late interrupt refusal release their cancellation slot; unresolved native mutations remain guarded.
