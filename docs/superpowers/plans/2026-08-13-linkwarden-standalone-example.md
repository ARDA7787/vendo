# Linkwarden Standalone Example Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the field-tested Linkwarden + Vendo integration as an official example: an AGPL fork under the `runvendo` org carrying our additive integration branch, plus an Apache-side pointer (`examples/linkwarden/` stub) and a docs-site guide in the vendo monorepo (ENG-381/382).

**Architecture:** Two artifacts, two licenses, one rule. The fork (`runvendo/linkwarden-vendo`, AGPL-3.0 like upstream) carries the *applied* integration as a small additive commit series on a `vendo-integration` branch pinned to upstream `62f1b81`. The vendo monorepo (Apache-2.0) carries the *canonical teaching content* — every integration snippet an integrator would copy lives Apache-side (stub README + docs-site guide), and the fork merely applies it. The stub directory has **no `package.json`**, so it never joins the pnpm workspace, the audit gate, or the root overrides (which would break next-auth v4).

**Tech Stack:** Linkwarden upstream (yarn 4.12 monorepo, Next 15 Pages Router, next-auth v4, Prisma/Postgres) + published `@vendoai/*` (pin 0.16.0 now; the post-merge release hasn't cut — see Global Constraints).

## Global Constraints

- **License wall:** zero Linkwarden (AGPL) code enters the vendo repo. Snippets flowing the other way (our route/registry into docs) are our own authorship — fine.
- **Fork is additive:** upstream files modified only where the integration demands it (7 files); everything else is new files. Eases AGPL §5 change-marking and upstream syncs.
- **Pin published versions:** `@vendoai/vendo` + `@vendoai/ui` at `0.16.0` (npm latest as of 2026-08-13). The `file:../vendo-branch-tarballs` resolutions in the local checkout must NOT ship. README notes what the next release adds (conversation history/resume, launcher offsets, automation-creation honesty).
- **Secrets:** `.env` / `apps/web/.env.local` never leave the machine. `.vendo/data/` (PGlite) is gitignored; only the `.vendo` contract files (`tools.json`, `catalog.json`, `overrides.json`, `theme.json`, `theme.extracted.json`, + `policy.json` if present) are committed.
- **Known issue disclosed:** machine-backed automations are down Cloud-side (ENG-413); the example's automation demo must use tool-step/host-event automations and say so.
- **Vendo repo rules apply to Phase B:** branch off fresh `origin/main`, PR, six green checks, no direct pushes; docs-site ships from main on merge.
- **Trademark courtesy:** README states "not affiliated with or endorsed by Linkwarden"; a courtesy note to upstream maintainers goes out around publish (Amr sends; draft in Task 9).

## Decisions taken (flag to Amr, defaults below)

1. Repo: **`runvendo/linkwarden-vendo`** (a true GitHub fork of `linkwarden/linkwarden`, renamed).
2. Default branch of the fork: **`vendo-integration`** (visitors land on the example, `main` tracks upstream).
3. Ship now pinned at 0.16.0 with a "next release adds…" note, rather than waiting for the release.

---

## Phase A — the fork

### Task 1: Create the fork under runvendo

**Files:** none (GitHub + git remotes).

- [ ] **Step 1:** `gh repo fork linkwarden/linkwarden --org runvendo --fork-name linkwarden-vendo --clone=false`
  - If org permissions refuse: Amr creates the fork in the GitHub UI (Fork → owner: runvendo → name: linkwarden-vendo), then continue.
- [ ] **Step 2:** In `C:\Vendo\New_Vendo_Workspace\linkwarden`: `git remote add vendo-fork https://github.com/runvendo/linkwarden-vendo.git`
- [ ] **Step 3:** `git checkout -b vendo-integration 62f1b81` (keeps the dirty integration files in the working tree — they are untracked/unstaged, so the branch switch carries them).

### Task 2: Replace the tarball wiring with published pins

**Files:** Modify `package.json` (root), `apps/web/package.json`, `.yarnrc.yml`; regenerate `yarn.lock`.

- [ ] **Step 1:** Root `package.json`: delete every `resolutions` entry pointing at `file:../vendo-branch-tarballs/*`; if `@vendoai/*`/`vendoai` resolutions remain, pin them `0.16.0` (telemetry `0.5.0`).
- [ ] **Step 2:** `apps/web/package.json`: dependencies `"@vendoai/vendo": "0.16.0"`, `"@vendoai/ui": "0.16.0"`; remove any `vendoai` alias entry left from experiments.
- [ ] **Step 3:** `.yarnrc.yml`: keep the `packageExtensions` block (the ai@6-beside-ai@5 fix — load-bearing, documented in Task 5's README) but change the exact `ai: "6.0.230"` pin to `ai: "^6.0.28"`. Remove `YARN_CHECKSUM_BEHAVIOR`-era artifacts if any.
- [ ] **Step 4:** `corepack yarn install` (regenerates `yarn.lock` against npm, not local tarballs).
- [ ] **Step 5:** Verify resolution: `corepack yarn why @vendoai/vendo` → exactly one copy, `0.16.0`, under `apps/web`; `corepack yarn why ai` → v6 nested under `@vendoai/vendo`, v5 only under `@linkwarden/worker`.

### Task 3: Verify the integration still runs on published 0.16.0

The local field-testing ran on branch tarballs; the fork ships npm 0.16.0. Same minor, but verify, don't assume.

- [ ] **Step 1:** Postgres up: `docker start linkwarden-postgres` (or the compose file if reset).
- [ ] **Step 2:** `cmd /c "corepack yarn web:dev > <scratchpad>\linkwarden-fork-test.log 2>&1"` (background), wait for `Ready in`.
- [ ] **Step 3:** Probe: `GET http://localhost:3000/api/vendo/status` answers the composition; log shows `[vendo] ready — … store: cloud`; sign-in probe (bad creds → 401, not 500).
- [ ] **Step 4:** Amr does one visual pass: overlay opens, chat answers, automations page renders. (History picker/F10 is absent on 0.16.0 — expected; noted in README.)

### Task 4: Commit series (additive, AGPL §5-clean)

**Files:** the 7 modified + 4 new paths, split by concern. `.vendo/data/` excluded via `.gitignore` line inside `apps/web/.vendo/` (add `data/` gitignore if `vendo init` didn't).

- [ ] **Step 1 — commit `feat: mount Vendo (server wire + provider + config)`:**
  `apps/web/app/api/vendo/[...vendo]/route.ts` (host principal resolver for next-auth v4 — the #1256 recipe), `apps/web/vendo/registry.tsx`, `apps/web/pages/_app.tsx` (provider mount), `apps/web/next.config.js` (`serverExternalPackages`), `apps/web/tsconfig.json` (Next-generated churn; keep), root+web `package.json`, `.yarnrc.yml`, `yarn.lock`, `apps/web/.vendo/` contract files.
- [ ] **Step 2 — commit `feat: automations status page`:** `apps/web/pages/vendo-automations.tsx`, `apps/web/components/Sidebar.tsx`.
- [ ] **Step 3 — commit `docs: example README + env template`:** `apps/web/.env.example` (VENDO_API_KEY, VENDO_BASE_URL=http://localhost:3000, model-key note), `README-VENDO.md` (Task 5), `NOTICE-VENDO.md` (one paragraph: fork of linkwarden/linkwarden at 62f1b81; modifications listed; AGPL-3.0 unchanged; not affiliated with/endorsed by Linkwarden).
- [ ] **Step 4:** Secrets sweep before any push: `git diff 62f1b81..HEAD | Select-String -Pattern 'vnd_|sk-|API_KEY=\w'` → must be empty (only `VENDO_API_KEY=` blanks in .env.example); confirm `.env*` untracked: `git status --short | Select-String '\.env'` shows only `.env.example`.
- [ ] **Step 5:** Commits end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

### Task 5: README-VENDO.md (the fork's front page)

- [ ] **Step 1:** Write with sections: What this is (official Vendo example on a real OSS product; not affiliated with Linkwarden; AGPL-3.0); The whole diff (list the 7+4 paths with one-liners); Quickstart (docker Postgres cmd, `.env` from `.env.sample` + `apps/web/.env.example`, `corepack yarn install`, `yarn prisma:deploy`, `yarn web:dev`, sign up, click the launcher); Identity note (next-auth v4 → host-resolved principal, link to docs guide); The ai@6 packageExtension explained; Known issues (0.16.0 lacks conversation-resume — next release; machine-backed automations Cloud-side outage ENG-413 — demo tool-step automations); Where the canonical guide lives (docs.vendo.run link).
- [ ] **Step 2:** Point GitHub's repo README rendering at it: fork Settings later, or simply have `README-VENDO.md` linked from a 3-line note appended nowhere — instead set the fork's default branch (Task 6) and rely on GitHub showing upstream `README.md`; add one line at the very top of the *new file only* — no upstream README edits.

### Task 6: Push + repo settings + smoke-clone

- [ ] **Step 1:** `git push vendo-fork vendo-integration`
- [ ] **Step 2:** `gh repo edit runvendo/linkwarden-vendo --default-branch vendo-integration --description "Official Vendo example: a real OSS product (Linkwarden) with an embedded Vendo agent. AGPL-3.0 fork; not affiliated with Linkwarden."`
- [ ] **Step 3:** Fresh-clone verification in scratchpad: clone, `corepack yarn install`, `corepack yarn workspace @linkwarden/web build` — build green is the gate (no DB needed for build; `prisma generate` runs offline).

### Task 7: Minimal CI on the fork

**Files:** Create `.github/workflows/build.yml` on `vendo-integration`.

- [ ] **Step 1:** Workflow: on push/PR → checkout, corepack enable, `yarn install --immutable`, `yarn workspace @linkwarden/web build`. Purpose: catch `@vendoai/*` bump breakage and upstream-sync breakage cheaply. Commit `ci: build check`.
- [ ] **Step 2:** Confirm the action run goes green on GitHub.

---

## Phase B — the Apache-side pointer + guide (vendo monorepo PR)

### Task 8: Branch, stub, guide, PR

**Files:** Create `examples/linkwarden/README.md` (NO package.json), `docs-site/vendo-agent/linkwarden.mdx`; modify `docs-site/docs.json` (nav entry in "Your product has no agent" group after `vendo-agent/overview`).

- [ ] **Step 1:** `git fetch origin && git checkout -b feat/eng381-linkwarden-example origin/main` (in-place branch, no worktree — Amr's preference).
- [ ] **Step 2:** `examples/linkwarden/README.md`: what it demonstrates; link to `runvendo/linkwarden-vendo`; the **canonical snippets inline** (route.ts with the v4 principal resolver, registry shape, `_app.tsx` mount, the packageExtension) — Apache-licensed here by living here.
- [ ] **Step 3:** `docs-site/vendo-agent/linkwarden.mdx` — the ENG-381 guide: narrative walk of the whole integration (detect → install → init → identity wall → resolver recipe → env → automations), each step naming the trap it dodges (from the fixes changelog), ending at the fork link. Add to `docs.json` nav.
- [ ] **Step 4:** Gates: `pnpm deps:guard` (stub has no package.json — nothing to guard, but run it), docs.json parse check, `pnpm test:affected` (docs-only → trivially green).
- [ ] **Step 5:** PR titled `docs: Linkwarden official example — pointer + integration guide (ENG-381/382)`; body links the fork, ENG-381/382, notes the license rationale (why pointer-not-vendor). Watch checks; merge only on Amr's word. PR body ends with the standard generation footer.

### Task 9: Close the loop

- [ ] **Step 1:** Linear: comment on ENG-381 + ENG-382 (route chosen, fork URL, PR link); update changelog file at workspace root.
- [ ] **Step 2:** Draft the upstream courtesy note for Amr to send (2 sentences: we published an integration-example fork under AGPL, happy to rename/adjust if you'd like).
- [ ] **Step 3:** When the next `@vendoai` release cuts: bump the fork's pins, drop the "next release" README note, verify build CI green. (Standing follow-up; note in ENG-382.)

## Self-review notes

- Spec coverage: fork (T1–7), pointer (T8), guide (T8), maintenance + comms (T9) — all four deliverables of the agreed route covered.
- The one irreversible-ish action is T1 (public repo creation) — Amr authorized runvendo placement explicitly on 2026-08-13.
- T3 exists because tarball-tested ≠ npm-tested; do not skip it.
