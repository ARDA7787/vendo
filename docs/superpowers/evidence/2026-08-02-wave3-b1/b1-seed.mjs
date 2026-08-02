/**
 * B1 browser-proof seeding. NEW-app generation against Maple's catalog is a
 * known engine failure (#631), so the proof seeds app rows through the same
 * records door packages/vendo/src/orgs-e8.test.ts uses, then drives the sharing
 * flow through the real product.
 *
 * Run with the demo-bank server DOWN — PGlite holds a cross-process writer lock.
 */
const ROOT = "/Users/yousefh/orca/workspaces/flowlet/wave3-stage";
const { createStore } = await import(`${ROOT}/packages/store/dist/index.js`);
const { VENDO_APP_FORMAT } = await import(`${ROOT}/packages/core/dist/index.js`);

const YOUSEF = "vendo-demo";

const text = (id, value, variant = "heading") => ({
  id,
  component: "Text",
  source: "prewired",
  props: { text: value, variant },
});

const app = (id, name, heading) => ({
  format: VENDO_APP_FORMAT,
  id,
  name,
  ui: "tree",
  tree: {
    formatVersion: "vendo-genui/v2",
    root: "root",
    nodes: [
      { id: "root", component: "Stack", source: "prewired", children: ["h"] },
      text("h", heading),
    ],
  },
});

const APPS = [
  app("app_b1_pulse", "Team pulse", "Team pulse — balance and trend for the whole desk"),
  app("app_b1_ledger", "Desk ledger", "Desk ledger — this desk's own rows, per person"),
  app("app_b1_nodir", "Quarter close", "Quarter close — the checklist the desk works through"),
  app("app_b1_stale", "Rate watch", "Rate watch — the desk's rate movements"),
];

const store = createStore({ dataDir: `${ROOT}/apps/demo-bank/.vendo/data` });
await store.ensureSchema();
const records = store.records("vendo_apps");
for (const doc of APPS) {
  await records.put({ id: doc.id, data: { subject: YOUSEF, enabled: true, doc }, refs: { subject: YOUSEF } });
  console.log(`seeded ${doc.id} -> ${YOUSEF}`);
}
console.log("rows now:", (await records.list({})).records.map((r) => `${r.id}(${r.data.subject})`).join(", "));
await store.close();
