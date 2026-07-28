# Verification evidence

Written verification records live here: per-campaign `README.md` files,
timing tables, transport logs, and store assertions. They are small, they
diff, and they explain what was proven.

**Media does not.** Screenshots, GIFs, and screen recordings are review
artifacts with a lifespan of one pull request. Committing them grew this
directory to 126MB — enough to break container-image uploads — so they are
gitignored (see the `docs/verification/**` rules in `.gitignore`) and were
removed from the tree on 2026-07-27.

Where to put media instead:

- **In the PR.** Drag images into the PR description or a review comment.
  That is where reviewers actually look, and GitHub hosts them.
- **Locally, for a lane's own record.** Keep them in the lane worktree or
  under the factory evidence directory outside the repo.

If a screenshot genuinely belongs in permanent documentation (a docs-site
page, a README diagram), put it under `docs/assets/` or the docs site's own
image directory — those are curated and reviewed, not per-run evidence.

Historical note: the media removed in the cleanup is still reachable in git
history if an old campaign's screenshots are ever needed; nothing was
rewritten.

## Proof runbook notes — generation pipeline (2026-07-28)

Two things cost a proof attempt each; both are environmental, not code.

- **Drive the CHAT surface at `/vendo`, not the Apps page.** `POST /api/vendo/apps`
  from `/vendo/apps` is request/response: no `data-vendo-view` parts arrive, so
  "skeleton on screen fast" and "groups lighting up progressively" are
  unobservable there. `onView` streaming renders on the chat surface, which is
  where those beats have to be filmed.
- **Reap dev servers with `pgrep -fl`, not just `lsof` on the port.** A detached
  `next-server` child survived a `pkill` and kept serving for eleven minutes
  while `lsof` on :3000 reported the port free — a whole proof ran against a
  server whose environment could not be verified.

Fresh worktrees also need `node packages/ui/scripts/build-jail-runtime.mjs`
before tests: turbo's shared cache replays `@vendoai/ui`'s build without
regenerating `src/tree/jail/runtime-bundle.gen.ts`, and the resulting failure
aborts ~20 unrelated packages, which reads as catastrophic breakage.
