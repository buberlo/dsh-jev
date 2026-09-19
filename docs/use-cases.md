# Use cases

Four concrete shapes of "Jev decides, code acts", all runnable from this
repository. Each one states what Jev answers, what deterministic code does,
and where the code lives.

The common rule: Jev never generates text, and its answers never bypass a
local invariant. It narrows, ranks, gates, or routes — code decides the rest.

## 1. Coding assistant: fewer tools, safer calls

**Situation.** An agent has dozens of tools: file reads and writes, test
runners, search, version control, network access. Most turns need three of
them. Occasionally the model proposes a call that does not match the task, or
repeats the same failing call.

**What Jev answers (one batched request).**

- Per category: *"Is a tool from category `files` relevant for this task?"*
  (Noul, independent per category)
- Per relevant category: *"Which of these tools fits the current step?"*
  (Choice over stable tool ids plus an explicit `none`)

**What code does.**

- Enforce mode narrows the visible tool set with scoped `tools.restrict` to
  the selected tools plus always-allowed ids plus uncertain alternatives.
- The next step recomputes everything, so a bad preselection cannot strand the
  agent.
- Before execution, three more questions gate the concrete call (task fit,
  missing information, restriction conflict). A `deny` wins over any `ask`.
- A bounded counter denies the *next* identical repeated call, with no model
  involved.

**See it:** `examples/coding`, `packages/jev-core/tests/selection.spec.ts`,
`docs/policy.md`.

## 2. Read-only ops router: diagnostics without side effects

**Situation.** A synthetic incident (`INC-4711`) reports disk-latency spikes.
The candidate tools include read-only diagnostics (`query_metrics`,
`fetch_host_events`, `inspect_storage`, `tail_logs`) and one mutating tool
(`restart_service`). The incident text says: *"Do not restart anything until
the cause is understood."*

**What Jev answers.** Per category, whether that category of tool is relevant —
`remediation` comes back low, the three read-only categories come back high.

**What code does.** The selection keeps the diagnostics; the mutating tool is
never part of the narrowed set. The hard policy stays local: even if a model
answer changed, `tools.restrict` can only intersect with existing
permissions, and the assessment's restriction question can only deny or ask —
never allow.

**Why this shape matters.** The model is allowed to be uncertain. Uncertainty
produces `expand` candidates, not silent widening. No customer system is
contacted in the example; every tool only prints what it would inspect.

**See it:** `examples/ops-readonly`, `evals/fixtures/decisions.v1.jsonl`
(cases `sel-en-003`, `sel-de-002`, `asm-de-003`).

## 3. Standalone game: free text onto bounded actions

**Situation.** A small world with valid actions (`look`, `go_north`,
`take_lamp`, `use_lamp`, `wait`). The player types free text in German or
English. The world state and consequences are plain deterministic code.

**What Jev answers.** One Choice question over the valid action ids plus
`__none__`, and one Noul question for "is this action impossible in the
current state?", sent together.

**What code does.** It applies the selected action to the world and prints the
outcome. An input that matches nothing selects `__none__` and the world stays
unchanged — an explicit "no action", not a guess.

**Why this shape matters.** This example imports only `@buberlo/jev-core`: no
DSH, no harness, no network. It is the proof that the core is usable in games
and other applications, and it is the smallest complete decision loop in the
repository.

**See it:** `examples/standalone-game`.

## 4. Harness integration: the same pattern in DSH and LangChain

**Situation.** Different agent harnesses need the same handful of decisions:
which tools to expose, whether a call is safe, which model to use.

**What Jev answers.** The questions in `docs/policy.md` — they are deliberately
harness-independent.

**What code does.** A thin adapter binds each decision to the harness's
verified extension points. In this repository that is DSH: `agent/pre-step`,
`tools/pre-execute`, `tools/result`, `agent/request`, `tools/restrict`,
`tools/guard`. The mapping is documented in `docs/architecture.md`, including
the comparison with LangChain's `TypeSafeClassifier`, `ModelRouterMiddleware`,
and `AutoModeMiddleware`.

**Why this shape matters.** The core package knows nothing about DSH, so the
same decisions can serve an MCP router, a search re-ranker, or a browser agent
without copying policy code.

**See it:** `packages/dsh-jev`, `docs/architecture.md`,
`docs/upstream-compatibility.md`.

## Choosing a shape for your own feature

1. **Start from the behavior**, not the model: what does the application show,
   select, change, or refuse?
2. **Keep known rules in code.** Exact lookups, thresholds, permissions, and
   execution never move into the model.
3. **Ask one narrow question per judgment.** Several independent questions in
   one request cost almost no extra latency.
4. **Include a no-match outcome** whenever the candidate set might not cover
   the input.
5. **Decide what uncertainty means** before you have answers: `ask` a human,
   keep the wider set, or fall back to the existing flow.
6. **Threshold on your data.** The defaults in `docs/policy.md` are
   uncalibrated placeholders.

## What these use cases deliberately do not do

- No free-form model explanations; decisions carry rule ids and measured
  values.
- No automatic escalation chains or endless retries; the loop guard counts and
  stops.
- No persistent decision cache; changed arguments are assessed again.
- No claim of support without an executed test for that exact path — see the
  status table in the README.
