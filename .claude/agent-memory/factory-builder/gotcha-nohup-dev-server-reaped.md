---
name: gotcha-nohup-dev-server-reaped
description: A dev server started with plain `nohup … &` inside a Bash call gets reaped mid-proof; only run_in_background:true survives across turns
metadata:
  type: project
---

A long-running dev server must be started with the Bash tool's
`run_in_background: true`, never with `nohup … &` inside a normal foreground
Bash call.

**Why:** during the wave-2 live E-proofs, three Maple `next dev` servers died
silently mid-run — no crash report in `~/Library/Logs/DiagnosticReports`, no
error in the server log, the process simply gone, and the driver saw
`RemoteDisconnected` / `http: 0` on the next request. Every death was a server
launched as `nohup ./run-maple.sh > log 2>&1 &`. The two servers launched with
`run_in_background: true` stayed up for the whole column and only stopped when
`pkill`ed. Backgrounded-with-`&` children of a completed Bash call are reaped;
managed background tasks are not.

**How to apply:** any dev server, tunnel, or watcher that has to outlive the
Bash call that starts it goes through `run_in_background: true`. Symptom to
recognise: a driver that worked for several minutes suddenly gets connection
refused, and the server log's last line is an ordinary successful request.
Related: [[gotcha-stale-dist-phantom-results]].
