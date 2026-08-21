# ngmcp

**A stateless MCP Apps server framework for core protocol `2026-07-28`.**

No sessions. No `initialize`. Zero runtime dependencies.

Early: `0.0.1`, and the API will change. What is here is tested, and what is
not here is listed at the bottom rather than implied.

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

Claude Code sends this as its first message to a server:

```json
{"method":"server/discover","params":{"_meta":{
  "io.modelcontextprotocol/protocolVersion":"2026-07-28",
  "io.modelcontextprotocol/clientInfo":{"name":"claude-code","version":"2.1.237"},
  "io.modelcontextprotocol/clientCapabilities":{"roots":{"listChanged":true},"elicitation":{}}}}}
```

`@modelcontextprotocol/sdk` 1.30.0 supports up to `2025-11-25`, and FastMCP,
`ext-apps` and `mcp-ui` all sit on that SDK. A server built on any of them
cannot answer the message above.

It does not follow that a server which *can* answer it gets a working
connection, and this is worth being exact about rather than optimistic.
Claude Code accepts that `server/discover` and then fails the `tools/list`
after it, on 2.1.237 and again on 2.1.238. Nothing reaches the server. So a
`2026-07-28`-only server is currently unreachable from it, and the way through
is the `initialize` shim below. The whole exchange, both halves, is in
[`docs/findings/001`](docs/findings/001-claude-code-2026-07-28-tools-list.md).

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
npm test               # build, types, unit, integration, concurrency, browser
npm run test:unit      # pure logic, no processes
npm run test:it        # real servers over real stdio pipes
npm run test:concurrency
npm run test:browser   # views, in Chromium and WebKit
npm run test:types     # contracts, which only the compiler can check
npm run test:mutants   # every test must kill the defect it exists for
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

Every shipping host still opens with `initialize` and an older version, so
there is a shim for that:

```ts
app.serve({ legacy: true });     // answers the handshake, holds nothing
```

What a session would have **remembered**, it **declares**: the handshake is
answered from fixed configuration and immediately forgotten, so two processes
behind a load balancer still answer identically. The cost is written down at
the top of `src/transport/legacy.ts` — a legacy client's real capabilities are
not observable per request, so what it is assumed to have is a statement about
the host rather than an observation of it.

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

## The view half

`@churning_mcp/server/view` is what runs inside the frame: a reactive core, and
components in four kinds, following Panel's taxonomy with one addition.

| Kind | What it is | What is here |
|---|---|---|
| **Pane** | draws a shape, knows nothing of its source | `dataTable`, `metric`, `lineChart`, `areaChart`, `barChart`, `scatterChart`, `sparkline`, `heatmap` |
| **Widget** | holds input state, answers to a person **and** an agent | `button`, `form` |
| **Layout** | arranges, holds no data | `stack`, `row`, `columns`, `card`, `tabs`, `dialog`, `divider`, `spacer` |
| **Surface** | the host relationship itself | `surface`, `hostBridge` |

Plus the group nothing else has, in `view/agent/`: `proposal` shows a change
beside what it would replace and applies nothing until a person accepts;
`approvalCard` requires provenance and makes a high-risk decision typed rather
than clicked; `taskList` never rolls progress back on cancellation;
`stream` says nothing at all when nothing arrived.

And the shells that make it a dashboard rather than a page — `listTemplate` and
`gridStack`, where panels load and refresh apart, a failed panel does not take
the board with it, and the layout comes out as a plain value the view hands to
a tool as an ordinary argument. There is nowhere else for it to live, which is
the protocol's answer rather than a limitation.

Every component ships three host states where a capability is involved, a
keyboard route, an `axe` assertion, and the mutant its tests must kill.

## The same shapes, in text

Half the hosts that exist have no frame — every terminal client, a log, a host
that fetched the `ui://` resource and never made the iframe. There, `content`
is the whole answer, and the usual thing to put in it is a sentence, which is a
description of a result rather than the result.

`src/text/` draws instead, with no DOM, so a server imports it directly:

```ts
import { bars } from "@churning_mcp/server";

bars({ rows: bands, label: "band", value: "rate", max: 100, unit: "%" });
```

```
First class      █████████████████████▍              63.0%
Second class     ████████████████▏                   47.3%
Third class      ████████▎                           24.2%
Everyone aboard  █████████████                       38.4%
```

`bars`, `histogram`, `sparkline`, `table` (plain or markdown) and `mermaid`. A
rate is drawn against 100 rather than against the largest value present, so
63 % is not a full bar and two charts of the same measure stay comparable.

## Examples

- **`examples/data-explorer`** — the contract, end to end: one declaration, a
  server checked against it, a view typed from it.
- **`examples/titanic`** — 891 real records, answered as bars, a histogram, a
  markdown table and a mermaid block. The example for a host with no frame.
- **`examples/gallery`** — every component as a tool, in a host you already
  use. Each screen tells the model what should be visible, so it can walk a
  person through it and record what they actually saw. The conversation is the
  test.

## Prompts, elicitation, sampling, subscriptions

All four are implemented, and two of them invert the direction: the server
sends a request and the client answers it. That needs a transport with a way
back, and where there is none the answer is `unavailable` rather than a hang.

```ts
const answer = await ctx.elicit({ message: "Why?", requestedSchema: { ... } });
// accept, decline, cancel — the person's — or unavailable, the client's.
```

`subscriptions/listen` is the stream that replaced the HTTP GET endpoint, and
it is how a dashboard panel updates without a conversation turn. A subscription
is an in-flight request rather than a session: it is cancellable the same way,
and when it ends nothing is left behind.

## Several servers, one server

```ts
const gateway = compose({
  name: "operations",
  upstreams: [
    { name: "deploys", transport: httpUpstream("https://deploys.internal/mcp") },
    { name: "incidents", transport: localUpstream(incidentsApp) },
  ],
});
```

Tools are namespaced, view uris are namespaced so two servers registering
`ui://app/table` do not collide, and the caller's own `_meta` is forwarded, so
an upstream tool that requires a capability sees the real client rather than
the gateway. One upstream being down is one upstream missing from the listing,
named in `_meta`, not a failed board.

## Not here yet

Named because a reader should not have to find out by trying.

- **`Map` and `Mermaid`.** One needs a projection, the other a parser.
- **A streaming HTTP transport.** `subscriptions/listen` works over stdio and
  is refused with a reason over a single HTTP response.
- **Claude Code cannot use it**, through no fault of this package. See
  `docs/findings/001`. Claude Desktop reaches it through the `initialize` shim
  in `src/transport/legacy.ts`; see `examples/gallery/README.md`.

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

## Licence

MIT.
