# The Titanic, drawn in text

891 real passenger records, four tools, and one point: a tool answers twice, and
the half most hosts can actually receive is the half usually thrown away.

`structuredContent` carries the data, for a host with a frame. `content` carries
what the model — and every terminal client, which today includes Claude Code —
receives. Writing a sentence there ("survival was higher in first class") is a
description of a result rather than the result. So these tools draw instead:

```
Survival by class, of 891 passengers
────────────────────────────────────
First class      █████████████████████▍              63.0%
Second class     ████████████████▏                   47.3%
Third class      ████████▎                           24.2%
Everyone aboard  █████████████                       38.4%
```

That is not a fallback. In a terminal it is the entire rendering, and it carries
the numbers where a sentence would have lost them.

## Run it

```
npm run build
```

Then point Claude Code at it:

```json
{
  "mcpServers": {
    "titanic": {
      "command": "node",
      "args": ["/absolute/path/to/ngmcp/examples/titanic/dist/server.mjs"]
    }
  }
}
```

```
claude --mcp-config mcp.json --strict-mcp-config \
  -p "show me titanic survival by class and by sex, quoting the charts exactly"
```

## The tools

| Tool | Draws |
|---|---|
| `survival_by` | Bars, grouped by class, sex, age band, port or relatives aboard |
| `age_distribution` | A histogram with its bucket edges printed |
| `passengers` | A markdown table that says how many rows it left out |
| `who_survived` | A mermaid flowchart, fenced, for a host that renders one |

## Two things that were wrong and are not

Both found by looking at the output rather than by a test:

- **A rate scaled to its own largest value.** 63 % drew as a full-width bar,
  which reads as everyone. Rates are now drawn against 100, which also makes two
  charts comparable — the `Everyone aboard` line is the same length in both.
- **An unrecorded age counted as zero.** 177 passengers have no age. Treating
  those as zero invents 177 newborns and drags the median down. Missing is
  `null`, and the chart says how many it left out.

## The handshake

Claude Code opens with `initialize`, so the shim in `src/transport/legacy.ts`
sits in front. Without it this server is unreachable from Claude Code, which is
`docs/findings/001`, re-tested against 2.1.238 on 2026-08-21:

```
node examples/titanic/dist/server.mjs                 # status: connected
NGMCP_STRICT=1 node examples/titanic/dist/server.mjs  # status: failed
```
