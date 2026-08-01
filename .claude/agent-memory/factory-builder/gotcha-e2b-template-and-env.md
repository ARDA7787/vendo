---
name: gotcha-e2b-template-and-env
description: Two e2b platform facts that cost template rebuild cycles — copy() sources resolve from the script dir, and create({envs}) never reaches a template's start command
metadata:
  type: project
---

Two e2b behaviours that are invisible until a live bake, both hit while baking
the box template (`packages/apps/box/build-template.mjs`) on 2026-08-01.

**1. `Template().copy(src, dst)` resolves `src` against the SCRIPT's directory,
not the process cwd, and a source that climbs out of it fails.** `process.chdir()`
does not move the base — the error is `TemplateError` / `No files found in
<scriptdir>/<src>` *before* the build starts. Anything from outside the script's
folder (a compiled `../dist/...` artifact) has to be STAGED into that folder
first and deleted after.

**2. `Sandbox.create({ envs })` does NOT put those vars in the environment of the
template's own start command.** A supervisor started by `setStartCmd` sees the
image's env, not the caller's. The shipped layer-3 box already works around this
with `pushBoxEnv` (`POST /agent/env` → write env.json → restart); anything new
must do its own handoff after create. Symptom when missed: the in-box Claude
Agent SDK answered "Not logged in · Please run /login" with a perfectly correct
`ANTHROPIC_API_KEY` in the create spec.

**How to apply:** budget two minutes per bake and expect at least one round trip;
verify the box actually RECEIVED what you sent (an `env | sort` dump written to a
synced path is the cheapest probe) rather than trusting that passing it was
enough. A resumed machine also boots with the SNAPSHOT's env, so any
token/credential the host asserts has to be re-asserted on every acquire, not
only on create.

Related: [[gotcha-generated-vendo-artifacts]]
