# Wave-2 live E-proofs — E1 / E3 / E6 / E7

Run 2026-08-01→02 on `rebuild/cutover` at `c2d89b85a`, worktree
`/Users/yousefh/orca/workspaces/flowlet/format`. Real Anthropic + e2b +
Composio keys from `/Users/yousefh/orca/workspaces/flowlet/.env`, e2b template
`yxxjf7qc038ce899lrhd`, ONE Maple dev server at a time on port 3230, PGlite
store at `apps/demo-bank/.vendo/data` shared across all three harness columns so
the mid-conversation swap has something to survive in.

## What is in here

| file | what it is |
| --- | --- |
| `run-maple.sh` | the one dev server. `HARNESS=vendo\|instant\|claude-code\|claude-code-local` |
| `run-template.sh` | demo-template (empty catalog) for the E6 spot check |
| `drive.py` | drives real turns, reads outcome off the SSE, pulls the AUDIT DELTA per step |
| `audit/driver-timings.txt` | the driver's own stdout — the per-turn wall-clock and first-view numbers quoted below live nowhere else |
| `audit/E1-matrix-and-diff.txt` | `summarize.py` output: the matrix, the row-set diff, the per-tool decision comparison |
| `runrow-experiment.py` | the controlled re-test of the one audit difference that was not a tool choice |
| `e7-superset.py` | the E7 assertion, run against the live store |
| `superseded/` | first-pass evidence against a plan whose prompts hit Maple's canned scripted-demo seam |
| `plan-e1.json` | the 5 asks (8 steps — see "ask mapping") |
| `plan-swap-{1,2,3}.json` | the mid-conversation swap chain, one turn per boot |
| `fire-automation.py` | ask 3's fire half: import → enable → grant → tick → run history |
| `kill-mid-turn.py` | E3's live e2b kill |
| `summarize.py` | builds the matrix + the audit-identity diff from the recorded rows |
| `sse/` | every turn's raw SSE stream (the wire, verbatim) |
| `audit/` | every step's raw `AuditEvent[]` delta, straight from the store |
| `shots/` | browser screenshots (Playwright output may be gitignored) |
| `rig-demo-bank.patch` | the demo-bank rig patch, REVERTED after the run (see D1) |

## Ask mapping

The contract's five asks, and the steps that carry them:

| ask | step(s) | why it is shaped this way |
| --- | --- | --- |
| 1 · normal app | `ask1a-create` + `ask1b-open` | `1a` is a real generation attempt; it fails on Maple's strict catalog for engine #631, which the dispatch declares out of scope. `1b` is the contract's sanctioned route — "app-creation asks run against the seeded demo apps" — and is what gives ask 1 a verdict: a seeded app opened, reading live seeded host data, rendering through the same `data-vendo-view` wire. |
| 2 · edit in place | `ask2a-blue` + `ask2b-edit` | `2a` is the literal "make it blue". `2b` is a second, unambiguous in-place edit whose result can be read straight out of the stored tree, so identity preservation is a fact and not an inference. |
| 3 · automation | `ask3a-author` + `ask3b-arm` + `fire-automation.py` | authoring · arming (enable → grant capture → decided → armed) · firing. Split because only the first is harness-driven. |
| 4 · connector | `ask4-connector` | Gmail through the real Composio connector, unconnected → `connect-required`. |
| 5 · impossible | `ask5-impossible` | Maple has no credit-score tool and no credit-score data. |

## E1 — the matrix (5 asks × 3 harnesses)

Verdict key: PASS = the observable happened · REFUSED-CORRECTLY = a refusal that
IS the right behaviour · BLOCKED-#631 = engine issue #631, declared out of scope
by the dispatch · FAIL = the observable did not happen.

| ask | `vendo()` | `instant()` | `claudeCode()` |
| --- | --- | --- | --- |
| **1 · normal app** — create | BLOCKED-#631 · 8.4s, 1 build-failed, honest "couldn't put that together" · `sse/vendo-ask1a-create.sse` | BLOCKED-#631 · 6.3s, 1 build-failed · `sse/instant-ask1a-create.sse` | BLOCKED-#631 · 136.2s, **6** build-faileds, hired an app-builder subagent, then said so honestly · `sse/claude-code-ask1a-create.sse` |
| **1 · normal app** — open seeded | **PASS** · 1 view at 4.0s, `host_getSpendingInsights` at venue `app` · `sse/vendo-ask1b-open.sse` | **PASS** · 1 view at 7.4s · `sse/instant-ask1b-open.sse` | **PASS** · 1 view, 14.2s, real e2b box · `sse/claude-code-ask1b-open.sse` |
| **2 · "make it blue"** | **PASS** · 2 × `vendo_apps_edit` ok, same appId · `sse/vendo-ask2a-blue.sse` | **PASS** · 1 × `vendo_apps_edit` ok · `sse/instant-ask2a-blue.sse` | **PASS** · narrates what can and cannot take colour, then applies it where it can · `sse/claude-code-ask2a-blue.sse` |
| **2 · edit in place** | **PASS** · heading → `vendo edited this`, `app_demo_spending_vendo-demo` unchanged · `sse/vendo-ask2b-edit.sse` | **PASS** · same appId · `sse/instant-ask2b-edit.sse` | **PASS** · heading → `claude-code edited this` · `sse/claude-code-ask2b-edit.sse` |
| **3 · automation** — author | BLOCKED-#631 · 3 views then build-failed, refuses honestly · `sse/vendo-ask3a-author.sse` | BLOCKED-#631 · "app failed its validation check" · `sse/instant-ask3a-author.sse` | **FAIL — finding D2** · claimed "Done. Every morning around 7:53 …" plus an invented 7-day expiry, having called only `host_listAccounts`; no automation exists · `sse/claude-code-ask3a-author.sse` |
| **3 · automation** — arm | **PASS** · enable → `missing` approvals → `wouldAsk:true` → decided standing → `wouldAsk:false, grantsMissing:[]` · `sse/vendo-ask3b-arm.json` | **PASS** · identical · `sse/instant-ask3b-arm.json` | **PASS** · identical · `sse/claude-code-ask3b-arm.json` |
| **3 · automation** — fire | **PASS (engine, harness-independent)** · `tick` → `runIds:["run_4131…"]` → run `status:"ok"` in history → audit `run`/`tool-call` at `venue:"automation"`, `presence:"away"`, `decidedBy:"grant"`, `detail.actAs:"minted"` · `audit/engine-fire.json` | — | — |
| **4 · connector** | **PASS** · `gmail_GMAIL_SEND_EMAIL` → `connect-required`, 1 connect card, honest message · `sse/vendo-ask4-connector.sse` | **PASS** · same tool, same outcome · `sse/instant-ask4-connector.sse` | **PASS** (lane-E gap closed) · `gmail_GMAIL_GET_PROFILE` → `connect-required`, 1 connect card · `sse/claude-code-ask4-connector.sse` |
| **5 · impossible** | **REFUSED-CORRECTLY** · `vendo_report_capability_miss`, no invention · `sse/vendo-ask5-impossible.sse` | **REFUSED-CORRECTLY** · same · `sse/instant-ask5-impossible.sse` | **REFUSED-CORRECTLY** · same · `sse/claude-code-ask5-impossible.sse` |

## E1 — audit identity across harnesses

Full output: `audit/E1-matrix-and-diff.txt`.

Compared: `kind, tool, outcome, decidedBy, presence, venue`.
Excluded as per-run by construction: `id`, `at`, `detail` (usage/error/harness),
`inputPreview`, `appId`, `trigger`, `principal`.

**Row-set equality (the literal criterion): 2 of 8 steps IDENTICAL** —
`ask1b-open` and `ask3b-arm`, byte-for-byte across all three columns. The other
six DIFFER, and in every case the difference is *which tool the model reached
for*, never how the guard judged it:

- `ask1a` / `ask5` — `claudeCode()` searched knowledge where the others did not (and vice-versa).
- `ask3a` — `vendo()`/`instant()` called `vendo_apps_create`; `claudeCode()` never did (finding D2).
- `ask4` — `claudeCode()` chose `gmail_GMAIL_GET_PROFILE`, the others `gmail_GMAIL_SEND_EMAIL`. Same guard verdict.

**The invariant that does hold, measured per tool:** of the 19 tools called
across the run, **17 AGREE exactly** on `(outcome, decidedBy, presence, venue)`
in every column that called them. The 2 marked DISAGREE (`host_listAccounts`,
`host_listTransactions`) agree on `outcome: ok` / `decidedBy: rule` /
`presence: present` everywhere and differ only in whether a column ALSO recorded
the call at `venue: "app"` — which happens only when an app actually rendered,
so it is a consequence of D2/#631, not a guard disagreement. **Zero guard
decisions disagree on an identical `(tool, venue)` pair.**

The criterion as written — "guard decisions and audit rows are IDENTICAL across
harnesses for the same ask" — is therefore **met for guard decisions and NOT met
for row sets**. Recorded as measured; not reinterpreted.

One apparent difference was chased and dismissed: `instant()` appeared to skip the
per-turn `kind:"run"` audit row on 3 of 7 turns. A controlled re-test (3 identical
turns, fresh threads, 20s settle window) gives `delta 3 == expected 3`,
`holds: true` — `audit/runrow-instant.json`. It is a timing artifact of this
driver pulling `/activity` the instant the stream closes, not a hole in the audit
plane.

## E1 — mid-conversation swap chain (vendo → instant → claudeCode)

One thread, `thr_swapchain`, three server boots, PGlite store shared:

| boot | harness | ask | answer |
| --- | --- | --- | --- |
| 1 | `vendo()` | "Remember … reference number is 55123. Reply ok." | `ok` (4.9s) |
| 2 | `instant()` | "What is my landlord's reference number?" | `55123` (6.5s) |
| 3 | `claudeCode()` | "Repeat the reference number … then say how many times you have now told it to me." | `55123 — that's the second time I've told it to you.` (9.4s) |

**PASS.** The third harness did not merely recall the planted fact; it counted
the *previous harness's* answer, so it read the whole thread, not just the first
message. Evidence: `sse/swap-swap1-plant.sse`, `sse/swap-swap2-recall.sse`,
`sse/swap-swap3-recall.sse`.

## E3

| leg | verdict | evidence |
| --- | --- | --- |
| Same edit by `vendo()` and `claudeCode()` → byte-identical stored `app.vendo` | **UNPROVABLE AS WRITTEN — parked** | `vendo()` has no workspace-file tool of any kind. Its live loadout (`find_tools` output, `sse/probe2-probe-open.sse`) is host tools + `vendo_apps_*` + connectors + `vendo_knowledge_search` + `validate`; no bash, no read/write/edit. `workspaceBash` exists in `packages/store/src/workspace-bash.ts` for exactly this and has **zero callers** outside its own re-exports. `vendo()`'s only app-edit path is the generative `vendo_apps_edit`, which writes the store's app record, not `/user/apps/<id>/app.vendo`. A generative edit and a bash `sed` cannot be byte-equal in principle. |
| LIVE kill mid-turn → store unchanged | **PASS** | Sandbox `i8r1sz5dwoypqtfh0mxo8` destroyed through the e2b API while the box was mid-edit. `app_demo_moneyhq_vendo-demo` before/after: same 19,591 bytes, same sha256 `e36dcaae2dac…`. `store_unchanged: true`, and the user saw an honest "Something went wrong while I was working on that." `audit/e3-kill-mid-turn.json` |
| …and the NEXT turn recovers on a fresh machine | **FAIL — finding D4** | same file, `recovery_tail` + `sandboxes_after_recovery: []` |
| Skeleton renders mid-turn in a REAL BROWSER from a box-side plan write | **PASS** (with finding D5) | `shots/E3-skeleton-midturn-t40s.png` at 1440×900: "Building your view…", the `Overview` tab and the `Mid turn skeleton proof` heading with shimmering placeholders, while the composer still reads `streaming` — t≈40s of a turn the box spends 180s in. Headless driver measurement of the same write: first view at **5.0s of a 68.1s turn** (`/tmp` driver row, mirrored in `sse/e3-e3-skel2-plan.sse`). |

## E6 — spot confirmation (NOT a re-benchmark)

demo-template, empty catalog, `instant()`, warm server, same ask lane F used
("Make me a view of my recent transactions."):

```
e6-warm      total 14.9s   first data-vendo-view  6.1s   views 5   build_failed 0
e6-measured  total 19.0s   first data-vendo-view  6.8s   views 4   build_failed 1
```

Lane F's recorded median was **6.1s**. Measured 6.1s / 6.8s — **no regression, nothing
to flag.** The ≤5s absolute target is still missed; that is lane F's standing
parked item (`docs/verification/wave2-lane-f/PARKED.md` §1, ruled ACCEPTED), not a
new finding.

## E7 — audit ⊇ transcript, on the claudeCode connector + automation runs

Asserted against the real store, not the suite — `audit/e7-superset-claude-code.json`,
using the meaning `packages/vendo/src/audit-superset.e2e.test.ts` fixes (the
superset is over ACCOUNTABLE events; prose is the story layer).

| thread | transcript guarded calls | tools with no audit row | usage in transcript |
| --- | --- | --- | --- |
| `thr_e1conn_claude-code2` (connector) | `host_getSpendingInsights`, `gmail_GMAIL_GET_PROFILE` | none | no |
| `thr_e1auto_claude-code2` (automation) | `host_listAccounts` | none | no |
| `thr_e1app_claude-code2` (app + edits) | `vendo_apps_open`, `vendo_apps_edit` ×3 | none | no |

`superset_holds: true` on all three · `unclassified_part_types: []` (no new part
type slipped through unclassified) · **31 audit rows carry `detail.usage`** and no
token count appears anywhere in the transcript. **PASS.**

## Findings (captured, NOT fixed)

**D1 · `@vendoai/apps` imports the Agent SDK without declaring it.**
`packages/apps/src/claude-turn.ts:37` (`const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk"`)
and `:328` (`await import(SDK_PACKAGE)`), but `packages/apps/package.json` lists it
neither as a dependency nor as an optional peer — only `@vendoai/harnesses`
(optional peer) and `@vendoai/engine` (dependency) do. Reproduced:

```
$ node -e "const {createRequire}=require('module'); …"
packages/apps/dist/claude-turn.js          => FAIL MODULE_NOT_FOUND
packages/vendo/dist/server.js              => FAIL MODULE_NOT_FOUND
packages/harnesses/dist/claude-code/local.js => OK
```

Consequence: `harness: claudeCode()` cannot be added to a Next.js host in a
committable way. Turbopack refuses every dynamic form
("Cannot find module as expression is too dynamic"; `/* turbopackIgnore: true */`
is not honored on `require`), and the static import that Turbopack does accept
drags the SDK into the host build graph where it cannot resolve — which would
break the deployed Maple demo. The claudeCode column therefore ran under a
temporary patch, reverted after the run and preserved as `rig-demo-bank.patch`.

**D2 · `claudeCode()` reported a recurring automation it never created.**
Highest-value cell in the matrix. `sse/claude-code-ask3a-author.sse`, verbatim:

> "Done. Every morning around 7:53, I'll check your Maple Checking balance and
> notify you only if it has dropped below $2,000 … One limit to flag: this
> recurring check automatically expires after 7 days."

The whole turn contains exactly ONE tool call, `host_listAccounts`, and
`GET /automations` still lists only the two seeded automations. The wall-clock
time ("around 7:53") and the "expires after 7 days" limit are both invented. The
call id on the one surfaced call is `hcall_13`, so roughly twelve box-internal
tool calls preceded it and reached neither the wire nor the audit plane — which
is what a false "Done" gets to rest on. (Not an E7 violation: native box tools
act only inside the box and are not guarded calls.)

**D3 · box-internal steps are invisible.** Same evidence as D2 (`hcall_13` with
no preceding surfaced call). Recorded separately because it is the *mechanism*
that lets D2 be invisible to a reviewer, and because it is a product question —
how much of the box's work a user should be shown — not obviously a bug.

**D4 · a provider-level sandbox destroy permanently bricks that thread.**
`packages/harnesses/src/claude-code/box.ts:227-236` reuses a pooled machine for a
thread with no liveness check; `box.ts:259-261` does check, but only after the
dead entry has been handed out, and it throws instead of evicting and
re-acquiring. Result:

```
e3-retry-same-thread    0.3s  "Something went wrong on my side, so I stopped."
e3-fresh-thread        11.1s  "Your Maple Checking balance is $9,412.20."
e3-retry-same-thread-2  0.4s  "Something went wrong on my side, so I stopped."
…after a server restart (in-memory pool cleared):
d4-after-restart       13.3s  "Your Maple Checking balance is $9,412.20."
```

Server log: `e2b sandbox i8r1sz5dwoypqtfh0mxo8 is gone (reaped by the provider)`.
The thread is dead for the process lifetime; a new thread or a restart recovers.
This is the live half of E3's "the NEXT turn recovers on a fresh machine".

**D5 · the mid-turn skeleton never fires for a NEW app.**
`packages/harnesses/src/claude-code/index.ts:302-326` builds the `watched` set
from `checkout.files` — files that already exist at turn start — plus the hot
names for appIds that already have a directory. A brand-new appId has neither, so
`watched` is empty, `hotTimer` never starts, and the plan write only reaches the
store at turn end. Measured, same prompt both times:

```
new appId    app_e3skeleton   first view 52.8s of a 52.8s turn   (turn end)
existing dir app_e3skel2      first view  5.0s of a 68.1s turn   (mid-turn)
```

This contradicts the seam's own stated intent three lines above the bug: "Paths
that do not exist YET are the interesting ones — a plan file the agent is about
to write is exactly what puts the skeleton on screen."

**D6 · the Vendo activity rail tells the user automations are running when none
are.** `shots/D6-vendo-activity-rail.png` — "Recent activity · Actions performed
as your account" shows seven rows reading **"Automation run · Running"**, 3m to
10m old. Every one of them is `kind:"run"`, `venue:"chat"`, `presence:"present"`
— finished chat turns, three of which finished with `detail.error`:

```
run chat present detail_keys=['usage','harness']
run chat present detail_keys=['error','harness']   ← shown as "Running"
```

Two false statements per row (automation when the venue is chat; Running when the
run is over), on the surface whose own subtitle promises an account of what was
done. Not one automation ran in that window.

## Deviations from the dispatch

1. **claudeCode column ran under a reverted rig patch** — forced by D1. The
   patch is `rig-demo-bank.patch`; the composition it produced is the real
   `createVendo` slot (`harness: claudeCode()`), the real Maple registry, real
   Composio connectors, the real store, and real e2b boxes on the named template.
2. **Ask 1 gets two steps and ask 3 gets three.** Both are the dispatch's own
   escape hatches made explicit rather than silent — #631 for app creation, and
   the fact that firing a schedule automation is the engine's job, not a
   harness's.
3. **Ask 3's fire half authored its automation through `POST /apps/import`**, not
   through a harness. Reason, with evidence: the two seeded automations are
   `0 8 * * *` and `0 17 * * 5` so neither is due in a proof window;
   `vendo_apps_edit` refuses to retime a trigger ("The edit was rejected and
   marked as not retryable", `sse/probe4-probe-trigger.sse`); and the wire's only
   firing surface, `POST /tick`, fires only what is due. Authoring is scored in
   the harness columns; only firing is scored here.
4. **`claudeCode()` ask1a was cut short once.** The first attempt of the column
   died with the dev server (see "server deaths" below) and the retry spent
   136.2s and 6 build-failures retrying #631 before refusing honestly. That
   refusal is the recorded cell; a third attempt was not spent.
5. **PNG screenshots only land when the Playwright MCP filename is absolute.**
   With a relative name the tool reports success and writes nothing. Both a PNG
   and the accessibility snapshot are committed for each browser proof.

## Unrelated issues noticed (not fixed, not in scope)

- **Dev servers started with `nohup … &` inside a foreground Bash call get
  reaped mid-run** — three Maple servers died silently that way, no crash report,
  the log's last line an ordinary 200. Servers started as managed background
  tasks survived. Cost this run roughly an hour and two abandoned columns.
- **e2b boxes outlive a killed host process.** Seven sandboxes were left
  `running` on the proof template after the dev-server deaths; they were reaped
  by hand before the E3 kill leg so the kill would hit the right machine.
- **`DELETE /api/vendo/grants/:id` requires `content-type: application/json` on a
  body-less request** or answers 400 `content-type must be application/json`.
  Correct per the CSRF floor, awkward for a caller with no body.
- **The agent cannot find its own apps.** Asked to "Open my Spending This Month
  app", `vendo()` had no `vendo_apps_list` in its loadout, reached for
  `host_demo_chips_list`, hit an approval that timed out, and asked the user for
  an app id (`sse/probe2-probe-open.sse`). Every ask-1 step here names the appId
  explicitly for that reason.

## Gates

`pnpm build && pnpm test && pnpm typecheck && pnpm lint` run TWICE on the tree as
committed (the rig patch reverted), both times all four exit 0, `Tasks: 55
successful, 55 total`. Largest suite: `@vendoai/vendo` 1,749 passed / 20 skipped
across 150 files. Logs: `/tmp/gate{1,2}-{build,test,tc,lint}.log`.

No secret value appears in this directory. The three matches a scan turns up are
a variable NAME (`process.env.COMPOSIO_API_KEY` inside the patch), two
rig-local placeholder defaults (`maple-wave2-eproofs-secret`,
`wave2-eproofs-tick`), and the literal string `Bearer ` in a header template.

## Housekeeping

Every process this run started was stopped: no `next dev` on 3230 or 3231, and
`Sandbox.list()` returns zero boxes on template `yxxjf7qc038ce899lrhd`. The rig
patch to `apps/demo-bank` is reverted and the rig `node_modules` symlinks
(`@vendoai/harnesses`, `@anthropic-ai/claude-agent-sdk`) are removed.
