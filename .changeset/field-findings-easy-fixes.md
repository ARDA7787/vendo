---
"@vendoai/vendo": patch
---

Two field-outage guards. The development automations ticker now arms once per process instead of once per composition — Next dev re-evaluates route modules on every recompile, and each orphaned composition kept its minute-ticker alive, grinding the hosted store into rate limits on long dev sessions (#1250; the flag rides `Symbol.for` on globalThis so it survives module churn). And the hosted store now names version skew instead of failing silently: when the console answers "Unknown store operation" for an op this client shipped with, the error says the real cause — this @vendoai/vendo is older than the console, update the package — and one loud log line reaches the server operator (#1251); previously every store-backed route just 501'd with nothing in the log.
