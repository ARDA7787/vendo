#!/usr/bin/env python3
"""Controlled test of the one audit-identity difference that is NOT a tool choice.

The E1 columns showed `instant()` missing the per-turn `kind: "run"` audit row on
several turns, while `vendo()` and `claudeCode()` wrote one every time. `run` rows
are where token usage lives, so a missing one is a hole on the plane billing and
reconciliation read (the rationale in `audit-superset.e2e.test.ts`).

This counts `run` rows tagged `detail.harness == <harness>` before and after N
identical cheap turns in fresh threads. Expected on a healthy harness: after -
before == N.

  HARNESS=instant PORT=3230 python3 runrow-experiment.py 3
"""
import json, os, sys, time, urllib.request, http.cookiejar

PORT = os.environ.get("PORT", "3230")
HARNESS = os.environ.get("HARNESS", "instant")
TURNS = int(sys.argv[1]) if len(sys.argv) > 1 else 3
HERE = os.path.dirname(os.path.abspath(__file__))
BASE = f"http://127.0.0.1:{PORT}"

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
opener.open(BASE + "/").read()


def run_rows():
    with opener.open(BASE + "/api/vendo/activity?limit=1000", timeout=180) as response:
        rows = json.loads(response.read())
    return [r for r in rows
            if r.get("kind") == "run" and (r.get("detail") or {}).get("harness") == HARNESS]


def turn(thread, text):
    body = json.dumps({
        "threadId": thread,
        "message": {"id": f"m_{int(time.time()*1000)}", "role": "user",
                    "parts": [{"type": "text", "text": text}]},
    }).encode()
    req = urllib.request.Request(BASE + "/api/vendo/threads", data=body,
                                 headers={"content-type": "application/json"})
    out = []
    with opener.open(req, timeout=600) as response:
        for line in response:
            out.append(line.decode("utf-8", "replace"))
    return "".join(out)


stamp = int(time.time())
before = run_rows()
streams = []
for index in range(TURNS):
    streams.append(turn(f"thr_runrow_{HARNESS}_{stamp}_{index}",
                        "What is my checking account balance? One short sentence."))
# The row is written when the run settles; give the settle a generous window so a
# LATE row is counted as present rather than missing.
time.sleep(20)
after = run_rows()

record = {
    "harness": HARNESS, "turns": TURNS,
    "run_rows_before": len(before), "run_rows_after": len(after),
    "delta": len(after) - len(before),
    "expected_delta": TURNS,
    "holds": len(after) - len(before) == TURNS,
    "turn_answers": [s.count("text-delta") for s in streams],
    "new_rows": [{"id": r["id"], "at": r["at"], "detail": r.get("detail")}
                 for r in after if r["id"] not in {b["id"] for b in before}],
}
json.dump(record, open(os.path.join(HERE, "audit", f"runrow-{HARNESS}.json"), "w"), indent=2)
print(json.dumps(record, indent=2))
