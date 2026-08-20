# ngmcp

**A stateless MCP Apps server framework for core protocol `2026-07-28`.**

No sessions. No `initialize`. Zero runtime dependencies.

Early: `0.0.1`, stdio only, and the API will change. What is here is tested,
and what is not here is listed at the bottom rather than implied.

```
npm install @churning_mcp/server
```

## One declaration, both sides

The shape of a tool's result is written once, in a file the server and the
view both import. The server is checked against it when it implements the
tool; the view is checked against it when it calls one.

```ts
// contract.ts
export const contracts = defineTools({
  list_deployments: {
    view: "ui://explorer/table",
    input:  type<{ env?: "production" | "staging" }>(),
    output: type<{ deployments: Deployment[] }>(),
    summary: (out) => `${out.deployments.length} deployments`,
  },
});

// server.ts — every tool must be implemented, with the declared shapes
app.implement(contracts, {
  list_deployments: async ({ env }) => ({ deployments: await load(env) }),
});

// view.ts — `contracts` is imported as a type, so no server code is bundled
const api = client<typeof contracts>({ bridge });
const { deployments } = await api.list_deployments({ env: "production" });
```

No `?.`, no `?? []`. Rename a field in the contract and both halves stop
compiling; add a tool and the server stops compiling until it is written.

`test/types/` compiles nine cases and requires the wrong ones to fail, because
a broken contract is a type error and nothing a runtime test can see.

```ts
import { App } from "@churning_mcp/server";

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

## Transports

The same `App` answers all of them, because nothing about it is
per-connection:

```ts
app.serve();                      // stdio
await app.serveHttp({ port: 8787 });   // node http
export default { fetch: app.fetch() }; // workers, deno, bun
```

There is no session id, no sticky routing and nothing shared between
instances. Two processes that have never spoken answer the same request
identically, which is asserted rather than claimed.

## Developing

```ts
import { devHost } from "@churning_mcp/server";
const { url } = await devHost(app, { watch: "./src" });
```

A host to develop against: it renders the view in a frame sandboxed the way
the specification requires, proxies the view's tool calls, logs the traffic
both ways, and reloads when a file changes.

It also has a **refuse the next call** switch. That is the point of it. A dev
host that only ever succeeds teaches an application to assume it always will,
and the first refusal then happens in front of a user.

## Not here yet

Named because a reader should not have to find out by trying.

- **Prompts, elicitation, sampling, `subscriptions/listen`.** None implemented.
- **Claude Code cannot use it**, through no fault of this package. See
  `docs/findings/001`.

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

Two of those tests are load-bearing and each has the mutation it exists to
catch in `test/mutants.json`: adding `allow-same-origin` to the frame must fail
the suite rather than quietly weaken every security claim the view makes, and
an action that needs a selection must not be offered without one.

`test/browser/a11y.test.js` mounts every component **alone** and runs `axe`
over it in both engines. Alone is the point. The first run in isolation found
a dialog that announced a different dialog's title, because the component minted
a fixed `id` and a view is allowed to hold two of anything.

## Mutants

```
npm run test:mutants
```

Every test here ships with the mutation it has to catch. The runner applies
each one to the source, runs the suite that claims to catch it, and requires
that run to fail. A mutant that survives means the test is decoration.

That is not a stylistic preference. Every defect this project has found so far
got past a green suite first, including two the runner caught on its first
pass: a cancellation test that passed because a second, redundant guard was
still in place, and a notification-lifetime test with no case where a handler
kept talking after it returned.

`test/mutants.json` carries the anchor, the suite and one line on what breaks.
A stale anchor fails the run rather than being skipped.
