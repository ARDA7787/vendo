#!/usr/bin/env python3
"""E3 · the LIVE leg: destroy the e2b machine while `claudeCode()` is mid-edit.

Run against a Maple started with HARNESS=claude-code. Sequence:

  1. snapshot the stored app document (the thing that must not partially change);
  2. start a turn that puts the box to work on a multi-step edit, in a thread of
     its own, on a background thread of this process;
  3. as soon as a sandbox for the proof template appears, KILL it through the
     e2b API — provider-level destroy, not an abort signal;
  4. read the stored app document again → must be byte-identical to (1);
  5. run the NEXT turn in the SAME thread → must recover on a fresh machine.

Writes kill-mid-turn.json next to the SSE it captured.
"""
import json, os, subprocess, sys, threading, time, urllib.request, http.cookiejar

PORT = os.environ.get("PORT", "3230")
APP = os.environ.get("APP_ID", "app_demo_moneyhq_vendo-demo")
TEMPLATE = os.environ.get("VENDO_BOX_TEMPLATE", "yxxjf7qc038ce899lrhd")
HERE = os.path.dirname(os.path.abspath(__file__))
BASE = f"http://127.0.0.1:{PORT}"
THREAD = "thr_e3kill"

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
opener.open(BASE + "/").read()

record = {"template": TEMPLATE, "appId": APP}
NODE = """
const { Sandbox } = await import('e2b');
const items = await Sandbox.list().nextItems();
const mine = items.filter((s) => s.templateId === process.env.TEMPLATE);
if (process.env.ACTION === 'kill') {
  for (const s of mine) { await Sandbox.kill(s.sandboxId); }
}
console.log(JSON.stringify(mine.map((s) => ({ id: s.sandboxId, state: s.state, at: s.startedAt }))));
"""


def e2b(action):
    out = subprocess.run(
        ["node", "--input-type=module", "-e", NODE],
        cwd=os.path.join(HERE, "..", "..", "..", "..", "apps", "demo-bank"),
        env={**os.environ, "TEMPLATE": TEMPLATE, "ACTION": action},
        capture_output=True, text=True, timeout=180)
    try:
        return json.loads(out.stdout.strip().splitlines()[-1])
    except Exception:                                # noqa: BLE001
        return {"_error": (out.stdout + out.stderr)[-400:]}


def app_doc():
    with opener.open(BASE + f"/api/vendo/apps/{APP}", timeout=120) as response:
        return response.read()


def turn(name, text):
    body = json.dumps({
        "threadId": THREAD,
        "message": {"id": f"m_{name}_{int(time.time()*1000)}", "role": "user",
                    "parts": [{"type": "text", "text": text}]},
    }).encode()
    req = urllib.request.Request(BASE + "/api/vendo/threads", data=body,
                                 headers={"content-type": "application/json"})
    blob = []
    try:
        with opener.open(req, timeout=900) as response:
            for line in response:
                blob.append(line.decode("utf-8", "replace"))
    except Exception as error:                       # noqa: BLE001
        blob.append(f"\n[driver] {type(error).__name__}: {error}\n")
    text_out = "".join(blob)
    open(os.path.join(HERE, "sse", f"e3kill-{name}.sse"), "w").write(text_out)
    return text_out


before = app_doc()
record["before_sha_len"] = [len(before), __import__("hashlib").sha256(before).hexdigest()]
record["sandboxes_before"] = e2b("list")

held = {}
worker = threading.Thread(target=lambda: held.update(
    sse=turn("victim",
             f"Work inside your machine on this: read the app {APP}, then write a new plan "
             f"file at /user/apps/{APP}/plan.vendo describing a two-tab rebuild of it, "
             "checking your work between each step. Take your time and be thorough.")))
worker.start()

# Wait for a machine to exist, then destroy it. No fixed sleep decides this.
deadline = time.time() + 240
seen = []
while time.time() < deadline:
    seen = e2b("list")
    if isinstance(seen, list) and seen:
        break
    time.sleep(3)
record["sandboxes_seen"] = seen
time.sleep(8)               # let the box actually start working before the axe
record["killed"] = e2b("kill")
record["sandboxes_after_kill"] = e2b("list")

worker.join(timeout=900)
record["victim_tail"] = (held.get("sse") or "")[-1200:]

after = app_doc()
record["after_sha_len"] = [len(after), __import__("hashlib").sha256(after).hexdigest()]
record["store_unchanged"] = before == after

record["recovery_tail"] = turn(
    "recovery", "Never mind that. Just tell me my checking balance in one short sentence.",
)[-900:]
record["sandboxes_after_recovery"] = e2b("list")

json.dump(record, open(os.path.join(HERE, "audit", "e3-kill-mid-turn.json"), "w"), indent=2)
print(json.dumps({k: v for k, v in record.items() if k not in ("victim_tail", "recovery_tail")},
                 indent=2))
print("\nvictim tail:", record["victim_tail"][-500:])
print("\nrecovery tail:", record["recovery_tail"][-500:])
