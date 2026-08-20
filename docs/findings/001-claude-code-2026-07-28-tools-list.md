# Claude Code rejects `tools/list` on the `2026-07-28` path

**Status.** Open, reproduced 2026-08-20 against Claude Code 2.1.237.
**Affects.** Every server that implements `server/discover`, not only this one.

## What happens

Claude Code opens with `server/discover`, gets a valid answer, sends
`tools/list`, gets a valid answer, and then reports:

```
Status: ! Connected · tools fetch failed
```

No error reaches the server. Nothing is retried. The exchange is four lines
and every one of them is well formed.

## The controlled experiment

The same tool descriptor was served two ways. Only the negotiation path
differs; the `tools/list` result is byte-for-byte identical.

| Server | Negotiation | Result |
|---|---|---|
| `server/discover`, `2026-07-28` | modern | `! Connected · tools fetch failed` |
| `initialize`, `2025-11-25` | legacy | `✔ Connected` |

The descriptor in both cases:

```json
{"name":"one","description":"One tool.",
 "inputSchema":{"type":"object","properties":{},"additionalProperties":false}}
```

Removing `server/discover` from the server makes Claude Code fall back to the
legacy handshake, and the identical tool list is then accepted. So the tool
descriptor is not the problem and the transport is not the problem.

## Captured wire

```
C->S {"jsonrpc":"2.0","id":"server-discover-probe-1","method":"server/discover",
      "params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28",
      "io.modelcontextprotocol/clientInfo":{"name":"claude-code","version":"2.1.237"},
      "io.modelcontextprotocol/clientCapabilities":{"roots":{"listChanged":true},
      "elicitation":{}}}}}

S->C {"jsonrpc":"2.0","id":"server-discover-probe-1","result":{"resultType":"complete",
      "supportedVersions":["2026-07-28"],"capabilities":{...},
      "_meta":{"io.modelcontextprotocol/serverInfo":{"name":"min","version":"1.0.0"}}}}

C->S {"method":"tools/list","jsonrpc":"2.0","id":0,"params":{"_meta":{...}}}

S->C {"jsonrpc":"2.0","id":0,"result":{"tools":[{"name":"one","description":"One tool.",
      "inputSchema":{"type":"object","properties":{"q":{"type":"string"}}}}]}}
```

## What was ruled out

- The tool descriptor shape. The legacy run serves the same one and passes.
- `inputSchema` with and without `properties`. Both forms fail on the modern
  path; the specification permits both.
- `_meta` carrying `io.modelcontextprotocol/serverInfo` on the `tools/list`
  result, which the changelog says servers SHOULD send. Present or absent,
  the result is the same.
- This framework. A raw twenty-line server with no dependencies reproduces it,
  as does an unrelated server from a different repository.

## What is still unknown

Why it fails. The request carries `"id":0`, and the `server/discover` request
that succeeds carries a string id, so a falsy-id comparison on the client is
one candidate. That is a guess and is not evidence: nothing observable from
the server side distinguishes it from any other client-side rejection.

## Why it is written down

This is the failure mode that makes MCP Apps hard to build. Everything on the
wire is correct, the client says only that something failed, and there is no
way from the server side to tell a protocol mistake from a client defect. The
same shape is reported in `modelcontextprotocol/ext-apps` issue 671, where a
UI resource never renders and the reporter can establish only that steps 1 and
2 happen and steps 3 to 5 do not.

Reproduce with `node test/fixtures/demo-server.mjs` behind any stdio client
that speaks `2026-07-28`.
