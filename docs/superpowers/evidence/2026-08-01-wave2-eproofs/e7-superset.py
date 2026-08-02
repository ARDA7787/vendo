#!/usr/bin/env python3
"""E7 · audit ⊇ transcript, asserted against the REAL store — not the suite.

`packages/vendo/src/audit-superset.e2e.test.ts` is the bar and it fixes the
meaning of "⊇": the superset is over ACCOUNTABLE events (a guarded call, an
approval, a failure, hired staff, tokens spent). Prose is the story layer, not a
member of the set — §3's routing table gives `text` no audit row on purpose.

So this checks, for the named threads:

  1. every guarded tool call PERSISTED in the transcript (`GET /threads/:id`)
     has a `tool-call` audit row for the same tool;
  2. usage appears on the audit plane (`run` rows carry `detail.usage`) and
     NOWHERE in the transcript.

Usage: PORT=3230 python3 e7-superset.py thr_x thr_y …
"""
import json, os, sys, urllib.request, http.cookiejar
from collections import Counter

PORT = os.environ.get("PORT", "3230")
LABEL = os.environ.get("LABEL", "claude-code")
HERE = os.path.dirname(os.path.abspath(__file__))
BASE = f"http://127.0.0.1:{PORT}"

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
opener.open(BASE + "/").read()


def get(path):
    with opener.open(BASE + path, timeout=180) as response:
        return json.loads(response.read())


activity = get("/api/vendo/activity?limit=1000")
audit_tools = Counter(row["tool"] for row in activity
                      if row.get("kind") == "tool-call" and row.get("tool"))
usage_rows = [row for row in activity
              if isinstance(row.get("detail"), dict) and "usage" in row["detail"]]

report = {"threads": {}, "audit_tool_rows": dict(audit_tools),
          "audit_usage_rows": len(usage_rows),
          "audit_usage_sample": (usage_rows[0]["detail"]["usage"] if usage_rows else None)}

for thread in sys.argv[1:]:
    messages = get(f"/api/vendo/threads/{thread}")
    if isinstance(messages, dict):
        messages = messages.get("messages", messages.get("thread", {}).get("messages", []))
    blob = json.dumps(messages)
    transcript_tools = Counter()
    unknown = []
    for message in messages:
        for part in message.get("parts", []):
            kind = part.get("type", "")
            # `dynamic-tool` is how the wire persists a guarded call whose schema
            # is resolved at runtime — it IS the tool part, not a sibling of one.
            if kind == "dynamic-tool" or (kind.startswith("tool-") and kind != "tool-invocation"):
                name = part.get("toolName") or kind.removeprefix("tool-")
                transcript_tools[name] += 1
            elif kind in ("text", "step-start", "reasoning") or kind.startswith("data-"):
                continue
            else:
                unknown.append(kind)
    missing = [tool for tool in transcript_tools if audit_tools.get(tool, 0) == 0]
    report["threads"][thread] = {
        "messages": len(messages),
        "transcript_tools": dict(transcript_tools),
        "tools_with_no_audit_row": missing,
        "superset_holds": missing == [],
        "usage_in_transcript": ("inputTokens" in blob or "outputTokens" in blob),
        "unclassified_part_types": sorted(set(unknown)),
    }

json.dump(report, open(os.path.join(HERE, "audit", f"e7-superset-{LABEL}.json"), "w"), indent=2)
print(json.dumps(report, indent=2)[:4000])
