# Parked — wave-2 lane F

## 1. The ≤5s skeleton target is not met (measured 6.1s median, 5.0s best)

**Acceptance criterion, verbatim (lane contract, E6):** "real layout on screen
≤5s typical via instant() (measured)".

**Not weakened, not reinterpreted. Measured and missed.**

Command:

```
cd docs/verification/wave2-lane-f
PORT=3222 LABEL=template-skel python3 drive.py /tmp/plan-v.json      # instant()
PORT=3222 LABEL=template-default python3 drive.py /tmp/plan-dv.json  # vendo()
```

Same ask ("Make me a view of my recent transactions."), demo-template (EMPTY
catalog, so nothing strict to violate), warm server, same model, same store,
sequential. Output — `docs/verification/wave2-lane-f/test-output/e1-e6-summary.txt`:

```
E6 skeleton — instant(), demo-template (empty catalog), warm
ask            total_s  first_view_s  views  build_failed
v-1               13.0           5.0      4             0
v-2               18.0           8.4      4             0
v-3               21.8           6.4      3             1
v-4               18.3           5.7      4             0
```

Time to the first `data-vendo-view` part: 5.0 · 8.4 · 6.4 · 5.7 → **median 6.1s**.

**Why this is parked rather than fixed.** The E6 gate that compares against
baseline PASSES with margin — the default `vendo()` on the identical ask reaches
its first view at a median of 14.6s, so `instant()` is 2.4× sooner and its whole
turn is 1.9× faster with a lower failure rate. The absolute 5s number is what
misses, and what is left in the 6.1s is not something a harness can remove:

- the routing call, ~1s, already on the cheapest seat (`fill`);
- the brain's plan call, the rest of it, on `claude-sonnet-4-6`.

`instant()` already makes **no resident model call at all** before the pipeline
starts — that was the whole latency idea and it is fully spent. Getting under 5s
from here means changing which model plans (a `fill`-tier or thinking-disabled
plan call), which lives in `packages/apps/src/generation/brain.ts` and is a
generation-pipeline decision, not a harness one. This lane does not own that
file and will not quietly repoint the brain's model to make its own number.

**The question for the orchestrator:** is the plan call allowed to run on a
faster seat, and if so which? That is a quality/latency tradeoff on generated-app
output, which reads like a Yousef call rather than a builder's.

**Ruling (orchestrator, 2026-08-01):** ACCEPTED for wave-2 land. Design §16 marks
the ≤5s number as standing until re-measured, and the E6 gates that compare
against baseline passed with margin (6.1s vs 14.6s median first view; 1/4 vs 4/5
build failures). The residual gap is the plan seat's model choice, which is
escalated to Yousef and not a harness change. The criterion is recorded as
missed, not met — this record is the standing evidence, which is why it lives
here in `docs/verification/` instead of the gitignored repo-root `PARKED.md`.

## 2. Engine issue #631 makes the app column noisy — flagged, not touched

Not a bug of this lane and explicitly out of scope, recorded because it is what
every app-ask failure in the evidence actually is. Verbatim from the server log
(`/tmp/maple-instant.log`, `/tmp/tmpl-instant.log`):

```
node "maplenetworthcard-1" props invalid for host component "MapleNetWorthCard" at props.valueCents: Required
node "maplespendingdonut-1" props invalid for host component "MapleSpendingDonut" at props.slices: Required
node "datatable-1" sets unknown prop "query" on prewired component "DataTable"; the renderer drops it.
  Allowed props: rows, columns, sortBy, limit, filterableBy, searchable, paginate, emptyState, caption
```

New detail worth passing on: it is **not** limited to strict host catalogs. The
third line is `DataTable`, a built-in prewired kit component, on demo-template
whose catalog is empty. And it hits the DEFAULT harness harder than the
specialist on matched samples (4 of 5 vs 1 of 4), so it is not harness-shaped at
all.

## 3. `agent.*` cannot move to `vendo()` options in this lane

The migration table states `agent` → harness option, which is the right
destination. It cannot be delivered here: `vendo()` declares only `model` and
`maxSteps`, and widening its options means editing
`packages/harnesses/src/vendo.ts`, which is not in this lane's "Files you own"
and not in its shared-with-coordination list either. The top-level `agent` key
therefore stays the accepted spelling, additively and with no host affected. The
diff is proposed in the lane report.

## 4. The dispatch's canonical env path does not exist

```
$ ls -la "/Users/yousefh/Desktop/Cool Code/flowlet/.env"
ls: /Users/yousefh/Desktop/Cool Code/flowlet/.env: No such file or directory
$ ls -la /Users/yousefh/orca/workspaces/flowlet/.env
-rw-------@ 1 yousefh  staff  774 Jul 26 21:44 /Users/yousefh/orca/workspaces/flowlet/.env
```

Used `/Users/yousefh/orca/workspaces/flowlet/.env` — the file that exists, and
the same one wave-1's `run-maple-harness.sh` sources. No secret value was echoed.
