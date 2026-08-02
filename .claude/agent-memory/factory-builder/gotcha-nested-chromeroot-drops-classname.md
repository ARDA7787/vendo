---
name: gotcha-nested-chromeroot-drops-classname
description: A nested ChromeRoot returns a bare fragment, silently dropping the className it was handed — every chrome surface mounted inside another loses its container box
metadata:
  type: project
---

`ChromeRoot` (packages/ui/src/chrome/chrome-root.tsx) checks
`useChromeRootPresence()` and, when nested, returns `<>{children}</>` — so a
`className` passed to it **disappears**. Any surface written as
`<ChromeRoot className="fl-thing">` renders with no container styling
(border, padding, gap) at every mount inside another chrome surface, and looks
correct only when mounted standalone.

Found 2026-08-01: `ShareDialog` (`fl-share`) and `ForkOffer` (`fl-share-fork`)
both rendered boxless inside `VendoPage`. Fixed by moving the class to an inner
`<div>`:

```tsx
<ChromeRoot>
  <div className="fl-share">…</div>
</ChromeRoot>
```

**Why:** jsdom tests query by role/text and pass either way; typecheck and the
export-surface registry say nothing about CSS. Only rendering it caught this.

**How to apply:** when authoring or reviewing a chrome surface, put the
container class on an inner div, never on `ChromeRoot`. When a surface "looks
unstyled but the CSS exists", check for nesting first. Related:
[[gotcha-ui-chrome-export-registry]].
