---
"@vendoai/actions": minor
"@vendoai/agent": minor
"@vendoai/core": minor
"@vendoai/mcp": minor
"@vendoai/vendo": minor
---

Connector discovery uses the broker's own search; execution stays ours.

`search_connectors` searched a local keyword index and then EXPANDED a matching
toolkit server-side, expecting the client to re-list via
`notifications/tools/list_changed`. Measured live, Claude Code's agent SDK
registers no list-changed handler for an HTTP MCP server — exactly one
`tools/list` per session — so a tool the model had just found was uncallable for
the rest of that session. The shape is one the industry has abandoned (GitHub
removed `--dynamic-toolsets`; Composio, whose catalog this is, never shipped it).

Three permanent tools replace it, so the listing never changes and callability
never depends on a re-list. They are ordinary registry tools, so they work on
both the `vendo()` and `claudeCode()` harness paths:

- **`find_service_tools(need)`** — the connector's OWN search. Each match
  carries the callable slug, the full input schema, the caller's connection
  status and the broker's next-step message, inline, so the model can construct
  a call with no second lookup. A match the broker has no schema for says so
  rather than inviting a guess.
- **`use_service_tool(slug, arguments)`** — looks up the broker's per-tool risk
  tag, maps it to a `RiskLabel`, lets the guard decide run/ask/refuse, executes,
  and lands on the audit trail with its toolkit named — the same guarded path a
  `host_*` call travels. An untagged tool is `ungraded` (ask-by-default); risk is
  never inferred from a tool's name.
- **`list_connections`** — unchanged, re-backed by the connector's connection API.

Both new tools exist only when a connector adapter can actually serve them
("no adapter, no tool"): `find_service_tools` and `use_service_tool` need a
connector implementing the new capabilities, `list_connections` needs only a
configured connector.

**Removed public surface.** All of it existed to serve lazy expansion:

- `@vendoai/core`: `ToolListingContext.listingScope` and
  `ToolRegistry.releaseListingScope`. A listing no longer has to be identified —
  every tool a run may call is on every listing that run is given.
- `@vendoai/actions`: `Connector.discoveryIndex`, `Connector.expandToolkits`,
  the `ToolkitIndexEntry` type, `ActionsRegistry.expandToolkits`, the `ctx`
  parameter of `ActionsRegistry.search`/`loadoutSeed`, and
  `ToolSearchOptions.maxExpansions`. `ActionsRegistry.loadoutSeed` now answers
  with every loaded tool and ignores its `connectedToolkits` argument: the
  argument only ever filtered lazily expanded connector tools, and there are
  none. New in their place, all optional:
  `Connector.searchTools`, `Connector.toolRisk`, `Connector.executeSlug`, and the
  `ServiceToolMatch` type. `Connector.toolkitOf` is unchanged — the pre-guard
  connect check still rides it.
- `@vendoai/agent`: `CONNECTOR_DISCOVERY_TOOLS` now names the three tools above;
  the discovery registry's ports changed shape with them.
- `@vendoai/mcp`: the door no longer advertises `tools.listChanged`, no longer
  diffs its listing around a call, and no longer keeps a per-session
  notification-replay flag.
- `@vendoai/vendo`: the `maxSearchExpansions` handler option.

**Known gap, deliberately not papered over.** A connector that cannot search
gets neither new tool, and the zero-key Vendo Cloud connector has no search
backend today — so a Cloud-default deployment that does not scope
`connectorApps` reaches connectors through the connect dock only until the
console broker exposes a search endpoint. Filling that with keyword scoring or
name-based risk inference is exactly what this change removes.
