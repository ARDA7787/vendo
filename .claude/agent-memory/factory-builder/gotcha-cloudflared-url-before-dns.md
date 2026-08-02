---
name: gotcha-cloudflared-url-before-dns
description: cloudflared prints its trycloudflare hostname well before the edge has it in DNS, and spawning it inside the script under test tangles their lifetimes
metadata:
  type: project
---

A cloudflared quick tunnel is the cheapest way to give an e2b box a real public
origin for the host's door. Two traps, both measured 2026-08-02:

1. **The URL is printed before it resolves.** The first `fetch` to it dies with
   `getaddrinfo ENOTFOUND`. Poll the real public URL until it answers *anything*
   (any status, including 404) before starting the proof.
2. **Do not `spawn` it from the script under test.** Doing so made the tunnel
   never become reachable at all, while the identical tunnel started from the
   shell answered 200 in ~10s. Start it separately and pass the URL in by env —
   the tunnel is scaffolding, not the thing being proven, and its lifetime should
   not be entangled with the proof's.

**How to apply:** `cloudflared tunnel --url http://localhost:PORT --no-autoupdate`
in a background shell, wait for the hostname with an `until grep` loop, then run
the proof with `PROOF_PUBLIC_URL=...`. Reap the tunnel when done — see the
recipe in `docs/verification/door-ctx/live-door-proof.mjs`.
