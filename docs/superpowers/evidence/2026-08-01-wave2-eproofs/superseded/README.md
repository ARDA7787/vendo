First-pass evidence against an earlier `plan-e1.json` whose ask-1 and ask-3 texts
matched Maple's scripted scenario cards verbatim — `scriptedThreadsResponse`
(apps/demo-bank/src/app/api/vendo/[...vendo]/route.ts) intercepted them and
streamed a CANNED turn, which is exactly the thing a harness proof must not
measure. Kept because `vendo-ask1-app` is the clean record of that trap: 6 views,
zero tool calls, and the seeded `app_demo_spending_vendo-demo` served without the
model ever running.

The scored plan avoids all five scenario prompts and all five chip prompts.
