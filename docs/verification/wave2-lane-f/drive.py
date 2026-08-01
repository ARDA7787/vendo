#!/usr/bin/env python3
"""Drive real chat turns against a running Maple and REPORT WHAT HAPPENED.

Outcome is read off the SSE stream, never the status code: a polite refusal at
HTTP 200 is a failure, and `data-vendo-build-failed` is a failure at 200 too.
Also times the FIRST view part, which is the ≤5s skeleton claim (E6).
"""
import json, os, re, sys, time, urllib.request, http.cookiejar

PORT = os.environ.get("PORT", "3220")
LABEL = os.environ.get("LABEL", "instant")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "test-output")
os.makedirs(OUT, exist_ok=True)
BASE = f"http://127.0.0.1:{PORT}"

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
opener.open(BASE + "/").read()   # pick up the autologin session cookie


def turn(name, thread, text):
    body = json.dumps({
        "threadId": thread,
        "message": {"id": f"m_{name}_{int(time.time()*1000)}", "role": "user",
                    "parts": [{"type": "text", "text": text}]},
    }).encode()
    req = urllib.request.Request(BASE + "/api/vendo/threads", data=body,
                                 headers={"content-type": "application/json"})
    start = time.time()
    first_view = None
    raw = []
    status = 0
    try:
        with opener.open(req, timeout=300) as response:
            status = response.status
            for line in response:
                chunk = line.decode("utf-8", "replace")
                if "data-vendo-view" in chunk and first_view is None:
                    first_view = time.time() - start
                raw.append(chunk)
    except Exception as error:                       # noqa: BLE001
        raw.append(f"\n[driver] {type(error).__name__}: {error}\n")
    seconds = time.time() - start
    blob = "".join(raw)
    with open(os.path.join(OUT, f"{LABEL}-{name}.sse"), "w") as handle:
        handle.write(blob)
    said = "".join(json.loads(d) for d in re.findall(r'"delta":("(?:[^"\\]|\\.)*")', blob))
    tools = sorted(set(re.findall(r'"toolName":"([a-z_]+)"', blob)))
    return {
        "ask": name, "thread": thread, "http": status,
        "seconds": round(seconds, 1),
        "first_view_s": None if first_view is None else round(first_view, 1),
        "views": blob.count("data-vendo-view"),
        "build_failed": blob.count("data-vendo-build-failed"),
        "approval": blob.count("data-vendo-approval"),
        "connect": blob.count("data-vendo-connect"),
        "tools": tools,
        "said": said.strip().replace("\n", " ")[:400],
    }


if __name__ == "__main__":
    plan = json.load(open(sys.argv[1]))
    rows = []
    for step in plan:
        row = turn(step["name"], step["thread"], step["text"])
        rows.append(row)
        print(json.dumps(row, indent=None), flush=True)
    with open(os.path.join(OUT, f"{LABEL}-results.json"), "w") as handle:
        json.dump(rows, handle, indent=2)
