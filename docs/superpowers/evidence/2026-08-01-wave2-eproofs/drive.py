#!/usr/bin/env python3
"""Drive real Maple turns against ONE running harness and record what happened.

Extends docs/verification/wave2-lane-f/drive.py with the piece E1's pass bar
needs: after every step, the AUDIT DELTA is pulled from the real store through
`GET /api/vendo/activity` and written next to the SSE. Outcome is read off the
SSE stream and the audit rows, never the status code — a polite refusal at
HTTP 200 is a failure, and `data-vendo-build-failed` is a failure at 200 too.

Plan steps (JSON array):
  {"name":..,"kind":"turn","thread":..,"text":..}
  {"name":..,"kind":"get","path":"/api/vendo/runs"}
  {"name":..,"kind":"post","path":"/api/vendo/automations/<id>/dry-run","body":{}}
"""
import json, os, re, sys, time, urllib.request, urllib.error, http.cookiejar

PORT = os.environ.get("PORT", "3230")
LABEL = os.environ.get("LABEL", "vendo")
RUN = os.environ.get("RUN", "1")
HERE = os.path.dirname(os.path.abspath(__file__))
SSE = os.path.join(HERE, "sse")
AUDIT = os.path.join(HERE, "audit")
os.makedirs(SSE, exist_ok=True)
os.makedirs(AUDIT, exist_ok=True)
BASE = f"http://127.0.0.1:{PORT}"

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
opener.open(BASE + "/").read()   # pick up the autologin session cookie

# Every audit row this driver has already seen, so each step reports its DELTA.
seen: set = set()


def activity(limit=1000):
    """One page is enough at limit=1000 (the store's cap) for a proof run, but
    stop early rather than silently truncate if it ever isn't."""
    try:
        with opener.open(BASE + f"/api/vendo/activity?limit={limit}", timeout=120) as r:
            rows = json.loads(r.read())
        if len(rows) >= limit:
            rows.append({"_driver_warning": f"activity page hit the {limit} cap"})
        return rows
    except Exception as error:                       # noqa: BLE001
        return [{"_driver_error": f"{type(error).__name__}: {error}"}]


def audit_delta(name):
    rows = activity()
    fresh = [r for r in rows if r.get("id") not in seen]
    for r in fresh:
        if r.get("id"):
            seen.add(r["id"])
    fresh.sort(key=lambda r: (r.get("at", ""), r.get("id", "")))
    with open(os.path.join(AUDIT, f"{LABEL}-{name}.json"), "w") as handle:
        json.dump(fresh, handle, indent=2)
    # The decision-relevant projection E1 diffs across harnesses.
    return [
        {k: r.get(k) for k in ("kind", "tool", "outcome", "decidedBy", "presence", "venue")}
        for r in fresh
    ]


def http_step(step):
    path, body = step["path"], step.get("body")
    data = None if body is None else json.dumps(body).encode()
    headers = {} if data is None else {"content-type": "application/json"}
    req = urllib.request.Request(BASE + path, data=data, headers=headers,
                                 method=step["kind"].upper())
    try:
        with opener.open(req, timeout=300) as response:
            payload = response.read().decode("utf-8", "replace")
            status = response.status
    except urllib.error.HTTPError as error:
        payload, status = error.read().decode("utf-8", "replace"), error.code
    except Exception as error:                       # noqa: BLE001
        payload, status = f"[driver] {type(error).__name__}: {error}", 0
    with open(os.path.join(SSE, f"{LABEL}-{step['name']}.json"), "w") as handle:
        handle.write(payload)
    return {"step": step["name"], "http": status,
            "body": payload[:1200], "audit": audit_delta(step["name"])}


def reset_step(step):
    """Put the shared store back to the state the FIRST harness column saw:
    grants revoked, automations disarmed. Without this, column two inherits
    column one's standing grants and its ask-3 audit rows differ for a reason
    that has nothing to do with the harness."""
    out = {"step": step["name"], "kind": "reset", "revoked": [], "disabled": []}

    def call(method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        headers = {} if method == "GET" else {"content-type": "application/json"}
        req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
        try:
            with opener.open(req, timeout=120) as response:
                return response.status, response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode("utf-8", "replace")
        except Exception as error:                   # noqa: BLE001
            return 0, f"[driver] {type(error).__name__}: {error}"

    status, body = call("GET", "/api/vendo/grants")
    try:
        grants = json.loads(body)
    except Exception:                                # noqa: BLE001
        grants = []
    for grant in grants if isinstance(grants, list) else []:
        if grant.get("id"):
            out["revoked"].append([grant["id"], grant.get("tool"),
                                   call("DELETE", f"/api/vendo/grants/{grant['id']}")[0]])
    status, body = call("GET", "/api/vendo/automations")
    try:
        automations = json.loads(body)
    except Exception:                                # noqa: BLE001
        automations = []
    for entry in automations if isinstance(automations, list) else []:
        app_id = (entry.get("app") or {}).get("id")
        if app_id and entry.get("enabled"):
            out["disabled"].append([app_id,
                                    call("POST", f"/api/vendo/automations/{app_id}/disable", {})[0]])
    out["audit"] = audit_delta(step["name"])
    return out


def automations_step(step):
    """Ask 3's second half: enable every automation the turn authored, FIRE it
    (dry-run is the only on-demand trigger the wire exposes), then read the run
    history back. One step so the appId never has to be hand-carried."""
    out = {"step": step["name"], "kind": "automations", "phases": []}

    def call(method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        headers = {} if method == "GET" else {"content-type": "application/json"}
        req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
        try:
            with opener.open(req, timeout=600) as response:
                return response.status, response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as error:
            return error.code, error.read().decode("utf-8", "replace")
        except Exception as error:                   # noqa: BLE001
            return 0, f"[driver] {type(error).__name__}: {error}"

    status, body = call("GET", "/api/vendo/automations")
    out["phases"].append({"phase": "list", "http": status, "body": body[:2000]})
    try:
        automations = json.loads(body)
    except Exception:                                # noqa: BLE001
        automations = []
    if isinstance(automations, dict):
        automations = automations.get("automations", automations.get("items", []))
    for entry in automations if isinstance(automations, list) else []:
        # The wire's shape is {app: {id, …}, enabled} — 07-automations §list.
        app_id = (entry.get("app") or {}).get("id") or entry.get("appId") or entry.get("id")
        if not app_id:
            continue
        for phase, method, path in (
            ("enable", "POST", f"/api/vendo/automations/{app_id}/enable"),
            ("dry-run", "POST", f"/api/vendo/automations/{app_id}/dry-run"),
        ):
            status, body = call(method, path, {})
            out["phases"].append({"phase": phase, "appId": app_id, "http": status,
                                  "body": body[:2000]})
    # The grant-capture half of ask 3: enable hands back the approvals the armed
    # automation still needs, and deciding them standing is what turns
    # `wouldAsk: true` into an automation that can run unattended.
    status, body = call("GET", "/api/vendo/approvals")
    try:
        pending = [row["id"] for row in json.loads(body) if row.get("id")]
    except Exception:                                # noqa: BLE001
        pending = []
    out["phases"].append({"phase": "approvals", "http": status, "ids": pending})
    if pending:
        status, body = call("POST", "/api/vendo/approvals/decide", {
            "ids": pending,
            "decision": {"approve": True,
                         "remember": {"scope": {"kind": "tool"}, "duration": "standing"}},
        })
        out["phases"].append({"phase": "decide", "http": status, "body": body[:400]})
        for entry in automations if isinstance(automations, list) else []:
            app_id = (entry.get("app") or {}).get("id")
            if not app_id:
                continue
            status, body = call("POST", f"/api/vendo/automations/{app_id}/dry-run", {})
            out["phases"].append({"phase": "dry-run-granted", "appId": app_id,
                                  "http": status, "body": body[:2000]})
    status, body = call("GET", "/api/vendo/runs")
    out["phases"].append({"phase": "runs", "http": status, "body": body[:4000]})
    with open(os.path.join(SSE, f"{LABEL}-{step['name']}.json"), "w") as handle:
        json.dump(out, handle, indent=2)
    out["audit"] = audit_delta(step["name"])
    for phase in out["phases"]:
        if "body" in phase:
            phase["body"] = phase["body"][:400]
    return out


def turn(step):
    name = step["name"]
    text = step["text"].replace("{H}", LABEL)
    thread = step["thread"].replace("{H}", f"{LABEL}{RUN}")
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
        with opener.open(req, timeout=900) as response:
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
    with open(os.path.join(SSE, f"{LABEL}-{name}.sse"), "w") as handle:
        handle.write(blob)
    said = "".join(json.loads(d) for d in re.findall(r'"delta":("(?:[^"\\]|\\.)*")', blob))
    return {
        "step": name, "kind": "turn", "thread": thread, "http": status,
        "seconds": round(seconds, 1),
        "first_view_s": None if first_view is None else round(first_view, 1),
        "views": blob.count("data-vendo-view"),
        "build_failed": blob.count("data-vendo-build-failed"),
        "approval": blob.count("data-vendo-approval"),
        "connect": blob.count("data-vendo-connect"),
        "tools": sorted(set(re.findall(r'"toolName":"([a-z_]+)"', blob))),
        "appIds": sorted(set(re.findall(r'"(app_[A-Za-z0-9_-]+)"', blob)))[:5],
        "said": said.strip().replace("\n", " ")[:600],
        "audit": audit_delta(name),
    }


if __name__ == "__main__":
    plan = json.load(open(sys.argv[1]))
    audit_delta("baseline")          # swallow whatever the boot seed already wrote
    rows = []
    for step in plan:
        kind = step.get("kind", "turn")
        handler = {"turn": turn, "automations": automations_step, "reset": reset_step}
        row = handler.get(kind, http_step)(step)
        rows.append(row)
        print(json.dumps(row), flush=True)
    with open(os.path.join(AUDIT, f"{LABEL}-results.json"), "w") as handle:
        json.dump(rows, handle, indent=2)
