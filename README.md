# ngmcp

**A stateless MCP Apps server framework for core protocol `2026-07-28`.**

No sessions. No `initialize`. One typed contract from a tool to the view that
renders it. Zero runtime dependencies.

```ts
import { App } from "ngmcp";

const app = new App({ name: "explorer", version: "1.0.0" });

app.view("ui://explorer/table", { html: TABLE_HTML });

app.tool("list_deployments", {
  description: "List recent deployments.",
  annotations: { readOnlyHint: true },
  view: "ui://explorer/table",
  input: { type: "object", properties: { env: { type: "string" } } },
  summary: (out) => `${out.deployments.length} deployments`,
}, async ({ env }) => ({ deployments: await load(env) }));

app.serve();
```

The view gets `structuredContent`. The model gets the sentence `summary`
returns. That split is the difference between an app that is cheap to run and
one that pastes a table into a language model on every call.

## Why this exists

Core MCP `2026-07-28` removed protocol-level sessions and the
`initialize`/`notifications/initialized` handshake. Every request now carries
its own protocol version and client capabilities in `_meta`, and servers must
implement `server/discover`.

Claude Code already speaks it. Its first message to a server is:

```json
{"method":"server/discover","params":{"_meta":{
  "io.modelcontextprotocol/protocolVersion":"2026-07-28",
  "io.modelcontextprotocol/clientInfo":{"name":"claude-code","version":"2.1.237"},
  "io.modelcontextprotocol/clientCapabilities":{"roots":{"listChanged":true},"elicitation":{}}}}}
```

`@modelcontextprotocol/sdk` 1.30.0 supports up to `2025-11-25`, and FastMCP,
`ext-apps` and `mcp-ui` all sit on that SDK. A server built on any of them
cannot answer the message above.

This package speaks one version and holds no per-connection state, which is
what lets the same `App` answer a stdio pipe, an HTTP handler or a serverless
invocation without behaving differently.

## What it enforces

Things the specification requires that are easy to get wrong, done here so a
handler cannot get them wrong:

- **`server/discover`** answers before any version is agreed, because it is how
  a client learns which versions exist.
- **`-32022`** with `data.supported` and `data.requested` for any other version.
- **`-32602`** for a request missing `io.modelcontextprotocol/protocolVersion`
  or `io.modelcontextprotocol/clientCapabilities`.
- **`-32021`** naming every capability a tool needs that the client did not
  declare.
- **`-32002` is never emitted.** This version retired it; a missing resource is
  `-32602`, and never an empty `contents` array.
- **Progress belongs to its request.** No token, no progress. Nothing after the
  response. Under transport pressure the newest progress replaces the backlog
  rather than joining it; a response is never treated that way.
- **Logs are request-scoped.** A request that did not set a log level gets none.
- **A closed pipe cancels everything in flight**, and the process exits rather
  than becoming an orphan holding a pipe.

## Concurrency

Requests are dispatched as they arrive, never queued behind each other, and
responses are correlated by id rather than by order. Statelessness is what
makes that safe: two requests share nothing.

`concurrency` bounds how many tools run at once (default unbounded).
`defaultTimeoutMs` and a per-tool `timeoutMs` abort work that overruns. Every
handler gets an `AbortSignal` that fires on cancellation, timeout or client
disconnect. Nothing is killed for you: forward the signal to whatever does the
real work, or it will outlive the call.

A request cancelled *before* its handler starts is answered rather than
started. Handing a handler a signal that has already fired is how
`await new Promise(r => ctx.signal.addEventListener("abort", r))` waits for an
event in the past and never returns. That case has its own regression test,
because it reproduced about half the time.

## Tests

```
npm test               # build, then unit, integration and concurrency
npm run test:unit      # pure logic, no processes
npm run test:it        # real servers over real stdio pipes
npm run test:concurrency
```

The integration and concurrency suites drive real subprocesses over real
pipes with a bare client rather than an SDK, because they have to send
malformed and out-of-version messages that an SDK refuses to construct.

## Licence

MIT.

## Views

A view is HTML in a frame with an opaque origin. `test/browser/` renders each
example the way a host does: start the server, read the `ui://` resource it
names, mount it in a sandboxed frame with no `allow-same-origin`, and proxy the
view's tool calls back to that server. Every assertion runs in **Chromium and
WebKit**, because the two disagree about focus, dialogs, insets and clipboard.

```
npm run test:browser
NGMCP_ENGINES=webkit npm run test:browser
```

Two of those tests are load-bearing and were checked against the mutation they
exist to catch. Filtering the table must cost no tool call, and adding
`allow-same-origin` to the frame must fail the suite rather than quietly
weaken every security claim the view makes.
