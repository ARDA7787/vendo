---
name: gotcha-workspace-unmounted-read-is-enoent
description: The Vendo workspace refuses a read on an UNMOUNTED path with ENOENT, not EACCES — so "no mount" and "no file" are byte-identical and a missing membership reads as absence
metadata:
  type: project
---

`WorkspaceStoreFs.bytesOf` (packages/store/src/workspace-fs.ts) throws
`ENOENT: no such file or directory` when `ownerOf(path)` returns undefined —
i.e. when the path is in a mount this façade does not have. `EACCES` is thrown
only by `assertWritable`, so **no read ever produces it**.

**Why it matters:** `workspaces.open(principal, { memberships })` derives the
`/orgs/<org>` mounts from `memberships` alone. Open without them and every
`/orgs/**` read comes back ENOENT — indistinguishable from "the file is not
there". That is exactly how wave-3 shipped org-admin policy with
`parseOrgPolicyFile` unreachable in production (2026-08-02, D1): the seam opened
the façade with no memberships, every org resolved to no rules forever, and
nothing anywhere said so.

**How to apply:**
- Any server-side code reading `/orgs/<org>/**` must open with the membership
  that justifies it: `open({kind:"user",subject:orgId},{memberships:[{org:orgId}]})`.
- Never classify a workspace failure as "absent" on the POSIX prefix alone.
  Assert the mount first (a mount is ONE path segment — `orgOfPath(path) === orgId`,
  so an org id containing `/` is unaddressable and reads as ENOENT too).
- A test that only covers the ABSENT and FAILED branches cannot see this. The
  only test that can is one that WRITES the file through the real workspace and
  reads it back.

Related: [[gotcha-generic-adapter-needs-explicit-refs]] — the same shape one
layer down (a write that is silently unreadable later).
