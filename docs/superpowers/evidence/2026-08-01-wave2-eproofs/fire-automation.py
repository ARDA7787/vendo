#!/usr/bin/env python3
"""E1 ask 3, the half no harness can reach: enable → FIRES → writes → run history.

Why this script exists, stated plainly so nobody reads it as a shortcut:

  * A schedule automation only fires when its cron/every window is DUE. Maple's
    two seeded automations are `0 8 * * *` and `0 17 * * 5`, so neither is due
    inside a proof window, and `vendo_apps_edit` refuses to change a trigger
    ("not retryable", recorded in sse/probe4-probe-trigger.sse).
  * The wire exposes no force-run: `/automations/:appId/{enable,disable,dry-run}`
    and `POST /tick`, which fires only what is due.

So the automation under test is created the way a HOST would create one — export
the seeded low-balance automation's document, retime it to `every: 30s`, and
`POST /apps/import` it back through the live wire (06-apps §7, the copy-only
.vendoapp boundary). Everything after that is the shipped path: enable captures
grants, the approvals are decided standing, and two authenticated ticks 35s
apart drive the real engine. Authoring is NOT proven here — it is proven (or
recorded as blocked) in the harness columns.
"""
import io, json, os, sys, time, zipfile, urllib.request, urllib.error, http.cookiejar

PORT = os.environ.get("PORT", "3230")
LABEL = os.environ.get("LABEL", "vendo")
TICK = os.environ.get("VENDO_TICK_SECRET", "wave2-eproofs-tick")
HERE = os.path.dirname(os.path.abspath(__file__))
BASE = f"http://127.0.0.1:{PORT}"

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
opener.open(BASE + "/").read()

log = []


def call(method, path, body=None, raw=None, headers=None):
    data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
    head = dict(headers or {})
    if raw is None and body is not None:
        head["content-type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=head, method=method)
    try:
        with opener.open(req, timeout=600) as response:
            out = (response.status, response.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as error:
        out = (error.code, error.read().decode("utf-8", "replace"))
    except Exception as error:                       # noqa: BLE001
        out = (0, f"[driver] {type(error).__name__}: {error}")
    log.append({"method": method, "path": path, "http": out[0], "body": out[1][:1500]})
    print(f"{method} {path} -> {out[0]} {out[1][:220]}", flush=True)
    return out


status, body = call("GET", "/api/vendo/automations")
seed = next((entry["app"] for entry in json.loads(body)
             if entry["app"]["id"].endswith("lowbalance_vendo-demo")), None)
if seed is None:
    print("no seeded low-balance automation to retime", file=sys.stderr)
    sys.exit(1)

document = json.loads(json.dumps(seed))
document["name"] = f"Low balance alert (30s, {LABEL})"
document["trigger"]["on"] = {"kind": "schedule", "every": "30s"}
buffer = io.BytesIO()
with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("app.json", json.dumps(document))
status, body = call("POST", "/api/vendo/apps/import", raw=buffer.getvalue(),
                    headers={"content-type": "application/octet-stream"})
app_id = json.loads(body)["id"] if status == 200 else None
if app_id is None:
    json.dump(log, open(os.path.join(HERE, "audit", f"{LABEL}-fire.json"), "w"), indent=2)
    sys.exit(1)

call("POST", f"/api/vendo/automations/{app_id}/enable", {})
status, body = call("GET", "/api/vendo/approvals")
pending = [row["id"] for row in json.loads(body) if row.get("id")]
if pending:
    call("POST", "/api/vendo/approvals/decide", {
        "ids": pending,
        "decision": {"approve": True,
                     "remember": {"scope": {"kind": "tool"}, "duration": "standing"}},
    })
call("POST", f"/api/vendo/automations/{app_id}/dry-run", {})

# Tick 1 plants the schedule cursor; tick 2, one interval later, is the one that
# is DUE and fires. Both are the real authenticated firing surface.
tick_headers = {"authorization": f"Bearer {TICK}"}
call("POST", "/api/vendo/tick", raw=b"", headers=tick_headers)
time.sleep(35)
call("POST", "/api/vendo/tick", raw=b"", headers=tick_headers)
time.sleep(20)
call("GET", f"/api/vendo/runs?appId={app_id}")
call("GET", "/api/vendo/runs")
call("GET", "/api/vendo/activity?limit=60")
json.dump(log, open(os.path.join(HERE, "audit", f"{LABEL}-fire.json"), "w"), indent=2)
