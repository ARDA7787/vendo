#!/usr/bin/env python3
"""Build the E1 matrix and the audit-identity diff from the recorded evidence.

Reads audit/<harness>-<step>.json (the raw AuditEvent rows the store returned)
plus sse/<harness>-<step>.sse, and prints two things:

  1. the 5-asks x 3-harnesses table with the observable per cell;
  2. the audit-identity diff — for each ask, the decision-relevant projection
     (kind, tool, outcome, decidedBy, presence, venue) per harness, and whether
     the three agree. Fields that legitimately differ per run (id, at, usage,
     inputPreview, appId, trigger) are named and excluded, not silently dropped.
"""
import json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
HARNESSES = ["vendo", "instant", "claude-code"]
DECISION_FIELDS = ("kind", "tool", "outcome", "decidedBy", "presence", "venue")
PER_RUN_FIELDS = ("id", "at", "detail", "inputPreview", "appId", "trigger", "principal")
STEPS = ["ask1a-create", "ask1b-open", "ask2a-blue", "ask2b-edit",
         "ask3a-author", "ask3b-arm", "ask4-connector", "ask5-impossible"]


def audit(harness, step):
    path = os.path.join(HERE, "audit", f"{harness}-{step}.json")
    if not os.path.exists(path):
        return None
    return json.load(open(path))


def sse(harness, step):
    for name in (f"{harness}-{step}.sse", f"{harness}-{step}.json"):
        path = os.path.join(HERE, "sse", name)
        if os.path.exists(path):
            return open(path).read()
    return ""


def projection(rows):
    return [tuple(row.get(field) for field in DECISION_FIELDS) for row in (rows or [])]


def cell(harness, step):
    rows, blob = audit(harness, step), sse(harness, step)
    if rows is None:
        return "MISSING"
    tools = sorted({m for m in re.findall(r'"toolName":"([a-z_]+)"', blob)})
    return {
        "views": blob.count("data-vendo-view"),
        "build_failed": blob.count("data-vendo-build-failed"),
        "connect": blob.count("data-vendo-connect"),
        "approval": blob.count("data-vendo-approval"),
        "tools": tools,
        "audit": projection(rows),
    }


print("== E1 matrix ==")
for step in STEPS:
    print(f"\n--- {step}")
    for harness in HARNESSES:
        c = cell(harness, step)
        if c == "MISSING":
            print(f"  {harness:<12} MISSING")
            continue
        print(f"  {harness:<12} views={c['views']} build_failed={c['build_failed']} "
              f"connect={c['connect']} approval={c['approval']} tools={c['tools']}")
        for row in c["audit"]:
            print(f"      {row}")

print("\n\n== audit-identity diff (decision-relevant fields only) ==")
print(f"compared:  {', '.join(DECISION_FIELDS)}")
print(f"excluded:  {', '.join(PER_RUN_FIELDS)} (per-run by construction)")
for step in STEPS:
    seen = {}
    for harness in HARNESSES:
        rows = audit(harness, step)
        if rows is None:
            continue
        seen[harness] = projection(rows)
    if len(seen) < 2:
        print(f"{step:<18} INCOMPLETE ({list(seen)})")
        continue
    # Order across harnesses is not a decision fact (the model may call reads in
    # any order), so compare as multisets.
    bags = {h: sorted(rows) for h, rows in seen.items()}
    same = len({json.dumps(v) for v in bags.values()}) == 1
    print(f"{step:<18} {'IDENTICAL' if same else 'DIFFERS'}   "
          + " | ".join(f"{h}:{len(v)}rows" for h, v in bags.items()))
    if not same:
        union = {tuple(r) for v in bags.values() for r in v}
        for row in sorted(union):
            where = [h for h, v in bags.items() if list(row) in [list(x) for x in v]]
            if len(where) != len(bags):
                print(f"    only in {','.join(where):<28} {row}")

print("\n\n== per-TOOL guard decision, across harnesses ==")
print("For every tool any column called, the (outcome, decidedBy, presence, venue)")
print("set each harness recorded. This is the claim that survives the model's free")
print("choice of WHICH tool to reach for.")
per_tool: dict = {}
for step in STEPS:
    for harness in HARNESSES:
        for row in audit(harness, step) or []:
            if row.get("kind") != "tool-call" or not row.get("tool"):
                continue
            key = row["tool"]
            decision = (row.get("outcome"), row.get("decidedBy"), row.get("presence"),
                        row.get("venue"))
            per_tool.setdefault(key, {}).setdefault(harness, set()).add(decision)
disagreements = 0
for tool in sorted(per_tool):
    columns = per_tool[tool]
    shared = [h for h in HARNESSES if h in columns]
    if len(shared) < 2:
        print(f"{tool:<34} only {shared[0]:<12} {sorted(columns[shared[0]])}")
        continue
    same = len({json.dumps(sorted(columns[h])) for h in shared}) == 1
    if not same:
        disagreements += 1
    print(f"{tool:<34} {'AGREE   ' if same else 'DISAGREE'} "
          + " | ".join(f"{h}={sorted(columns[h])}" for h in shared))
print(f"\ntools called by 2+ harnesses that DISAGREE on the guard decision: {disagreements}")
