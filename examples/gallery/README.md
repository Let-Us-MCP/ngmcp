# The gallery

Every component in this library, reachable as an MCP tool, in a host you
already use. It exists so the claim "these components work" stops being a test
result and becomes something a person looked at.

Each `show_` tool draws a screen **and** tells the model exactly what should be
visible on it. The model reads those out, you say what you actually saw, and it
records each answer with `grade`. At the end `report` says what failed. The
conversation is the test.

## Build it

```
npm install
npm run build
```

That produces `examples/gallery/dist/server.mjs` and the bundled view beside
it. Nothing is fetched at runtime — a view runs in a frame with an opaque
origin where nothing can be — so the whole thing is inlined at build time.

## Point Claude Desktop at it

Add this to `claude_desktop_config.json`. On macOS that is
`~/Library/Application Support/Claude/claude_desktop_config.json`; on Windows,
`%APPDATA%\Claude\claude_desktop_config.json`.

```json
{
  "mcpServers": {
    "ngmcp-gallery": {
      "command": "node",
      "args": [
        "/absolute/path/to/ngmcp/examples/gallery/dist/server.mjs"
      ]
    }
  }
}
```

Use the absolute path; the host does not run it from this directory. Restart
Claude Desktop, then say:

> Walk me through the ngmcp gallery.

That reaches the `walk_the_gallery` prompt, which tells the model how to run
the session: draw a screen, read the checks, wait for what you saw, record it,
and never grade anything itself, because it cannot see the view.

Or drive it directly: **"show me the charts screen"**, **"now the dashboard"**.

### If nothing renders

The view not appearing is the known failure in this area rather than a surprise
— see `docs/findings/001` here, and `modelcontextprotocol/ext-apps` issue 671
and `anthropics/claude-ai-mcp` issue 165, where a host fetches the `ui://`
resource and then never creates the frame. The tools still answer as text, and
every check is still worth reading, but you will be grading prose rather than a
picture.

The dev host below renders the same views with no host in the way, so it is the
quickest way to tell a broken component from a host that did not draw it.

## Or run it without a host at all

```
NGMCP_DEV_HOST=1 NGMCP_SCREEN=charts node examples/gallery/dist/server.mjs
```

It prints a URL. The dev host renders the view in a frame sandboxed the way the
specification requires, proxies its tool calls, and logs the traffic both ways.
It also has a **refuse the next call** switch and an **ask to tear down**
button, so the three host states and the teardown handshake can be exercised
deliberately rather than waited for.

Set `NGMCP_SCREEN` to any of `charts`, `table`, `widgets`, `layout`, `agent`,
`dashboard`, `surface`.

## What is on each screen

| Tool | Screen | What it is for |
|---|---|---|
| `show_charts` | Line, area, bar, scatter, sparkline, heatmap | Every chart, with a keyboard route through the data |
| `show_table` | Data table, metrics, sparkline | Local sort, filter, page and select, costing no tool call |
| `show_widgets` | Button, form | The three host states, and prefill that never submits |
| `show_layout` | Stack, row, columns, card, tabs, dialog, toast, banner | Arrangement, and a modal that works in the sandbox |
| `show_agent` | Proposal, approval card, task list, stream | The components an agent needs a person for |
| `show_dashboard` | Shell and board | Panels from **two different servers** behind one gateway |
| `show_surface` | Host capabilities and refusals | What this host granted, withheld and refused |

And three that test the host rather than the components:

| Tool | Asks |
|---|---|
| `confirm_destructive` | Does this host support **elicitation**? |
| `ask_the_model` | Does this host support **sampling**? |
| `stir` | Does anything hold a `subscriptions/listen` stream? |

Each answers `unavailable` rather than hanging when the host does not have it.
That is a fact about the host, reported as one.

## Grading

- `list_checks` — every check, in order.
- `grade(check, verdict, note)` — `pass`, `fail` or `unsure`, with what you saw.
- `report` — the tally, and what has not been looked at.

Verdicts are written to `examples/gallery/dist/report.json`, or wherever
`NGMCP_GALLERY_REPORT` points. Note what that is **not**: it is not a session.
Every call names the check it is grading, nothing is remembered about who is
asking, and restarting the server mid-conversation loses nothing.

## The handshake

Claude Desktop, like every shipping host, opens with `initialize` and a
protocol version older than `2026-07-28`. This server has no `initialize`, on
purpose. So a shim sits in front of it and answers the handshake — and holds
nothing while doing it: what a session would have remembered is instead
declared as configuration. See `src/transport/legacy.ts` for what that costs.

To talk to the server as `2026-07-28` intends, with no shim at all:

```
NGMCP_STRICT=1 node examples/gallery/dist/server.mjs
```

Then every request must carry its own `_meta`, there is no handshake to make,
and a host that cannot do that gets `-32602` telling it exactly which fields
are missing.
