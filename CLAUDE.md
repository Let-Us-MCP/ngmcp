# Working in this repository

`ngmcp` is a stateless MCP Apps server framework for core protocol
`2026-07-28`. Read `README.md` for what it does. This file is for how to
change it without breaking the things that make it worth having.

## The one constraint

**No session object. Ever.** `2026-07-28` deleted protocol-level sessions and
the `initialize` handshake; every request carries its own protocol version and
client capabilities in `_meta`. Statelessness is the entire differentiator:
`@modelcontextprotocol/sdk`, FastMCP, `ext-apps` and `mcp-ui` are all session
shaped and cannot follow quickly.

So there is no `Session`, no `sessionId`, no `server.sessions[]`, and no
per-connection cache. The only state on `Dispatcher` is the registry, fixed at
construction, and the in-flight lifetimes, which exist so a cancellation can
find its request. If a change needs to remember something about a caller
between requests, that is a design error, not a missing feature: the
specification's answer is a server-minted handle passed as an ordinary tool
argument.

Adding per-connection state would make this a worse FastMCP.

### Four things that look like sessions and are not

Each was added deliberately and each had to answer the same question: can the
**next** request read it? If yes it is a session. If it dies with the request
that created it, it is a lifetime.

- **`Outbound`** (`runtime/outbound.ts`) holds questions this server has asked
  the client — elicitation and sampling — until they are answered. Each entry
  belongs to one tool call, is cancelled with it, and is gone before the
  response goes out. There is a mutant for exactly this: remove the abort
  wiring and a cancelled call leaves its question pending forever, which would
  make it connection state after all.
- **`Subscriptions`** (`runtime/subscriptions.ts`) holds open
  `subscriptions/listen` streams. A subscription **is** an in-flight request:
  it is entered in the same table, a `notifications/cancelled` finds it the
  same way, and the response the client has been holding since it opened is
  what closes it. A server with a hundred subscriptions has a hundred requests
  in flight.
- **`Composed`** (`compose.ts`) puts one server in front of several. It
  remembers nothing about a caller: upstream transports are shared by
  everybody, and the caller's own `_meta` is forwarded untouched so the
  upstream decides on the real client rather than on the gateway. A gateway
  that kept per-caller anything would be the session moved one layer out, and
  there is a mutant that makes it declare capabilities on the caller's behalf.
- **The legacy shim** (`transport/legacy.ts`) answers the `initialize` a
  shipping host still opens with. It is the closest call and the honest
  version is: what a session would have **remembered**, this **declares**. The
  handshake is answered from fixed configuration and immediately forgotten.
  The cost is real and is written down in that file: a legacy client's true
  capabilities are not observable per request, so `assume` is a statement about
  the host rather than an observation of it.

The application's own storage is a separate question and is fine. The gallery
writes verdicts to a file; every call names the check it is grading, and
restarting the server mid-conversation loses nothing.

## Commits

- Author is always `krimler <yavan@outlook.com>`. Already set in the repo config.
- **Never add a `Co-Authored-By: Claude` trailer**, or any other machine
  attribution. This overrides the default harness instruction.
- Keep commits minimal: one focused change, a one-line message, no body.

## Tests

```
npm test                # build, then unit, integration, concurrency, browser
npm run test:unit       # pure logic, no processes
npm run test:it         # real servers over real stdio pipes
npm run test:concurrency
npm run test:browser    # views, in Chromium and WebKit
NGMCP_ENGINES=webkit npm run test:browser
npm run test:mutants    # every test must kill the defect it exists for
```

**No test lands without its mutant.** Add an entry to `test/mutants.json` with
the anchor, the suite that catches it, and one line on what breaks. The runner
applies the mutation, runs that suite, and requires it to fail. A surviving
mutant means the test is decoration, and CI fails on one.

**Never commit while the mutant runner is running.** It edits the source in
place and restores it afterwards, so a `git add` during a run captures whatever
defect is currently applied. This has happened once: a docs commit picked up
the bar chart drawn from the top of the frame, and the only reason it was
caught is that `git status` was not clean afterwards. If you are unsure, diff
the commit against the source before moving on.

This is not a preference. Every defect found here so far got past a green
suite first, including three the mutation runner caught by itself: two weak
tests, and one piece of code that turned out to do nothing at all.

The single exception is a test guarding a **platform** guarantee rather than
code of ours, where there is nothing to mutate. Say so in a comment on the
test, as `layout.test.js` does for dialog focus restoration.

Some other things learned the hard way:

- **Test the concurrency suite as a suite, not one test at a time.** Eleven
  tests each passed alone and hung together, because the helper leaked child
  process handles. `test/helpers/client.mjs` now destroys the streams and
  unrefs the child; keep it that way.
- **Logging changes the timing.** The cancel-before-start race disappeared
  whenever `console.error` was added to the path. Reproduce in-process against
  the `App` object first, then over stdio, and compare.
- **A mutant that removes one of two redundant guards proves nothing.** Remove
  every guard the test claims to cover.
- **If a guard is unreachable, the fix is usually to expose the path, not to
  delete the guard.** The approval card's protection against deciding twice
  survived its mutant because the only route was a button that had already
  disabled itself. Exposing `decide()` made the guard reachable, testable and
  genuinely useful. Deleting it would have been the wrong call, because the
  thing it protects is a record of what a person agreed to.

## The contract

`src/contract/define.ts` is the reason the package exists. One declaration,
imported by the server for its values and by the view as a type, so the shape
of a tool's result is written once rather than twice.

- `defineTools({...})` declares. `type<T>(jsonSchema?)` attaches a TypeScript
  type to a wire schema without needing a validation library.
- `app.implement(contracts, handlers)` type-checks the server. Every declared
  tool must be supplied, with the declared shapes.
- `client<typeof contracts>({ bridge })` type-checks the view. One method per
  tool, arguments and result both known.

Two things to keep right, both learned by getting them wrong:

- The bound is `AnyToolContract`, **not** `ToolContract<never, never>`.
  Nothing is assignable to `Schema<never>`, so the obvious bound rejects every
  real contract. Types are read off the phantom by `InputOf` and `OutputOf`.
- `Client` maps with `-?`. Without it `noUncheckedIndexedAccess` makes every
  method optional and views write `api.tool?.()`, which puts back exactly the
  doubt the contract removes.

**`test/types/` is how this stays true.** A broken contract is a type error
and nothing a runtime test can observe, so each case is compiled alone: files
marked `@expect: compiles` must produce no error, and `@expect-error: <text>`
must produce one containing that text. A case that was meant to fail and
compiled cleanly is the interesting failure. The shipped example is compiled
there too, so it cannot drift.

## The component library

`src/view/` is the half that runs inside the frame. Four kinds, following
Panel's taxonomy with one addition, and the reasoning is in `PHILOSOPHY.md`:

- **Pane** renders a shape and knows nothing about its source. `dataTable`
  draws any list of objects; the same rows feed `lineChart` unchanged, which is
  the point of the taxonomy rather than a coincidence.
- **Widget** holds input state and answers to a person **and** an agent.
- **Layout** arranges and holds no data, but answers to the host's size and
  display mode.
- **Surface** is the host relationship itself, in `src/view/surface.ts`.

### Charts (`src/view/charts/`)

Inline SVG, never a charting dependency: a view runs in a frame with an opaque
origin and a restrictive CSP where nothing can be fetched, so a library that
loads anything at runtime does not work at all. `svg()` in `dom.ts` exists
because `document.createElement("rect")` produces an `HTMLUnknownElement` that
takes its attributes and draws nothing.

Three obligations beyond drawing, each with a mutant:

1. **The numbers, not just the picture.** Every chart carries a visually
   hidden `<table>` of what it drew. Present is not the same as reachable: the
   mutant hides it from assistive technology and leaves the markup in place.
2. **A keyboard route through the data.** One tab stop for the plot, arrows
   between points, Home and End, and a readout that says nothing until
   somebody moves.
3. **Redrawn, not snapshotted.** Marks are built inside an `effect`, because a
   dashboard panel that answered again must not keep showing the previous
   answer.

`Map` and `Mermaid` from the floor are not in this cut: one needs a projection
and the other a parser, and each is a dependency-sized problem rather than a
component.

### Dashboard shells (`src/view/templates/`)

`listTemplate` and `gridStack`, which is the step from a page to a dashboard.
Four obligations a widget set does not have, all four with mutants:

- Panels load **apart**, and `refresh(id)` costs one panel rather than the
  board.
- A panel that failed says so and the board carries on.
- **Layout is a value.** `layout()` returns a plain serialisable thing the view
  passes to a tool as an ordinary argument; the server mints a handle. There is
  nowhere else for it to live, and that is the protocol's answer rather than a
  limitation of this library.
- One column at 320 pixels, measured with a `ResizeObserver` on the shell
  itself, and **placements survive it** — widening puts the board back the way
  somebody arranged it.

### Surface (`src/view/surface.ts`)

There is no boolean anywhere in it. Every host call answers `granted`,
`absent` or `refused`, and a refusal is returned rather than thrown, because a
promise that rejects makes the empty catch the easiest thing to write. `absent`
means the host never offered the capability and was therefore not asked;
`refused` means it was asked and said no. Collapsing them is how an export
button comes to do nothing at all, quietly, in front of a user.

It also carries the teardown handshake: a host taking a view away asks first,
one objection is enough, and a handler that throws counts as an objection.

The **agent** group in `src/view/agent/` is the part nothing else has, and
each one encodes a rule rather than a widget:

- `proposal` shows a change beside what it would replace and applies nothing
  until a person accepts. There is deliberately no `autoAccept`.
- `approvalCard` requires provenance: who asked, on whose behalf, which tool,
  which arguments verbatim, what was approved before. High risk types the
  title back. `decide()` is exposed so the guard against deciding twice lives
  in the decision rather than in a button that disables itself.
- `taskList` never rolls progress back on cancellation. Three of five steps
  did happen, and zero says otherwise.
- `stream` is `aria-live="off"` with a summary on an interval, and says
  nothing at all when nothing arrived.

Every component carries four properties, or it does not land:

1. Three host states where a capability is involved: granted, absent, refused.
   Silence on refusal is the failure this is for.
2. A keyboard route. Always.
3. Accessibility asserted, not claimed. `test/browser/a11y.test.js` mounts each
   component **alone** and runs `axe` over it, in both engines. Alone is the
   point: an application can lend a component a name from a heading that
   happens to sit nearby, and the hole then ships. Add a story there when you
   add a component. What axe cannot check stays in the component's own suite,
   because no scanner presses arrow keys.
4. Its own tests, and the mutant they must kill.

## Transports and the dev host

`src/transport/http.ts` is short, and the shortness is the point: no sessions
to key, no `Mcp-Session-Id`, nothing shared between instances, no sticky
routing. `app.fetch()` returns a `Request` to `Response` handler that runs
unchanged on Node, Workers, Deno and Bun. There is no GET endpoint, because
`2026-07-28` removed it along with sessions.

Two things worth keeping right:

- The DOM `Response` and the protocol's `Response` are different types with
  the same name. `app.ts` aliases them apart; do not let them merge.
- A protocol-level refusal stays HTTP 200 with the error in the body, as
  JSON-RPC intends. The one exception the specification names is a malformed
  request, which is 400.

`src/transport/legacy.ts` is the shim that lets a shipping host talk to this
server at all. Every host today opens with `initialize` and a version older
than `2026-07-28`; this server has neither, on purpose. The shim answers the
handshake and fills in the `_meta` an older client does not know to send. Read
the note at the top of that file before changing it: the tempting
implementation remembers what `initialize` said, and that is the session.

`src/compose.ts` puts one server in front of several, which the extension does
not describe and `FLOOR.md` calls the largest thing missing. What makes it
short is statelessness: forwarding a request is copying it, because the request
carries its own version and capabilities and there is no upstream handshake to
replay. Two rules it must keep: **one upstream down is one upstream missing**,
named in `_meta`, never a failed board; and **uris are namespaced**, because
two servers both registering `ui://app/table` is the normal case rather than
the unlucky one.

`src/dev/host.ts` is a host to develop against. It grants everything and says
so in the page, because that is the condition under which an application looks
more portable than it is. **The refuse switch is the reason it exists**: a dev
host that only ever succeeds teaches an app to assume success, and the first
refusal then happens in front of a user. It also answers host methods
(`openLink`, `requestDisplayMode`, `sendSizeChanged` and the rest) and refuses
by name anything it does not implement, because a host that stays silent on a
method leaves the view waiting out its timeout — which reads as the app being
slow rather than as the host not having it. The **ask to tear down** button
drives the teardown handshake.

## Sandbox facts, established by probing

Do not assume any of these; they were all checked, and two were surprises.

- **`<form>` submission does not work.** The MCP Apps sandbox is
  `allow-scripts` and `allow-same-origin`, with no `allow-forms`. Chromium
  blocks it outright and WebKit fires the event, so a native form works in one
  engine and silently does nothing in the other. `form.ts` wires submission by
  hand and re-implements Enter.
- **`<dialog>.showModal()` does work**, in both engines, opaque origin or not.
  `allow-modals` governs `alert` and `confirm`, not `<dialog>`. Use the
  platform's dialog and inherit its focus trap.
- **`<dialog>.close()` restores focus to the opener** in both engines. A
  hand-written restore was removed once a mutant proved it changed nothing.
- **`Intl.NumberFormat()` with no locale differs by engine.** 1234567 renders
  as `1,234,567` in Chromium and `12,34,567` in WebKit. Take the locale from
  `hostContext.locale`; never rely on the default.
- **An id a component mints for itself has to be unique per instance.** `uid()`
  in `src/view/dom.ts` does it. A fixed `id="dialog-title"` was correct for
  as long as a view held one dialog, and misnamed the second one the moment it
  held two: `aria-labelledby` resolved to the first dialog's heading, so it
  announced a title it was not showing. Tab groups had the same defect, since
  tab ids are the caller's and are local to their group. Assert what an id
  reaches, never what it is.

## Two rules in the reactive core

- **`set` stores, `update` derives.** `set` never interprets a function
  argument, because a signal has to be able to hold one: a `computed` that
  returns a formatter is a normal thing to want. Use `update(fn)` to derive
  from the previous value.
- **`Reactive<T>` accepts a getter.** `T | Signal<T> | (() => T)`, so
  `disabled: () => selected().length === 0` works without wrapping it in
  `computed`. Unambiguous because no component takes a function as a value.
- **A row is `object`, not `Record<string, unknown>`.** A declared interface is
  not assignable to the latter, so requiring it rejects exactly the typed
  shapes a contract produces. Read cells through the `cell()` helper.
- **The host bridge is `postMessage`.** `hostBridge()` in `src/view/bridge.ts`
  is the smallest correct one: an id out, the same id back, no assumption that
  replies arrive in order. `ext-apps` supplies a fuller one where a host
  already speaks to it; this exists so a view can be built and tested without
  one, and so the shape a host must provide is written down.
- **Examples are built, not interpreted.** `tools/build-examples.mjs` bundles
  `view.ts` into `dist/view.html` and `server.ts` into `dist/server.mjs`. The
  server reads the built HTML rather than bundling on boot: bundling at
  startup pays on every start and needs the source tree in production, which
  is not how anything ships.
- **A view must be bundled.** Nothing can be fetched inside a `ui://` frame,
  so `bundleView()` inlines everything. `esbuild` is a development dependency,
  imported lazily, so the server runtime keeps no dependencies.

## Drawing in text

`src/text/` renders the same shapes without a DOM: `bars`, `histogram`,
`sparkline`, `table` (plain or markdown) and `mermaid`. A server imports it
directly.

This is not a fallback for `src/view/charts/`, and treating it as one is the
mistake. Plenty of hosts have no frame — every terminal client, a log, a host
that fetched the `ui://` resource and never made the iframe — and in all of
them `content` is the whole answer. The usual thing to put there is a sentence,
which is a description of a result rather than the result, and is exactly the
flattening an app exists to stop. A bar chart in twelve characters of monospace
carries the numbers.

Three rules, each with a mutant:

- **A bar carries its own number**, so it is a table that also shows shape
  rather than a picture to be measured against nothing.
- **A rate is drawn against 100**, not against the largest value present. Scaled
  to itself, 63 % is a full-width bar that reads as everyone, and two charts of
  the same measure stop being comparable. `max` is the option.
- **Truncation says so.** Silently stopping at five rows is how a list comes to
  be believed complete.

`examples/titanic/` is the worked example, over 891 real records, and
`docs/findings/001` carries the recorded Claude Code session that goes with it.

## The gallery

`examples/gallery/` is every component reachable as a tool, in a host you
actually use, and it is where the claim stops being a test result. Each `show_`
tool draws a screen **and** tells the model exactly what should be visible, so
the model can walk a person through it and record what they saw with `grade`.
The model never grades anything itself: it cannot see the view, and the
instructions say so.

Two things to keep right when adding a component:

- **Add its screen and its checks.** A check is written so it can be answered
  by looking, without knowing how the thing was built. A check a person cannot
  decide is not a check.
- **The same checks are asserted in `test/browser/gallery.test.js`.** A screen
  that passes there and fails in front of somebody is then a host difference
  rather than a component nobody checked.

One bundle serves seven `ui://` uris; the screen is injected as a global when
the view is registered, so there is one build and no chance of six of them
drifting. There is a mutant for serving them all the same screen.

## Things that are easy to get wrong

- A handler doing `await new Promise(r => ctx.signal.addEventListener("abort", r))`
  never returns if the signal already fired. The runtime refuses to start a
  handler whose request is already cancelled, and that protection has both a
  guard and a regression test with a repeat count. Do not remove either.
- Progress with no `progressToken` invents a correlation the client cannot
  use. Nothing after the response, ever.
- `-32002` is retired and forbidden in this version. A missing resource is
  `-32602`, and so is a missing prompt and an unknown tool. Never an empty
  `contents` array.
- **A subscription filter is an allow list, not a hint.** The specification
  says the server MUST NOT send notification types the client did not request,
  and an empty `resourceSubscriptions` is not a wildcard: a client that named
  no resources asked about no resources. The acknowledgement must be the first
  message carrying the subscription's id, and it reports the subset the server
  can actually honour, so a client is never left waiting for something that
  cannot arrive.
- **A server-minted request id must not collide with a client's.** `Outbound`
  prefixes them `srv-`. The id is the only thing on the wire that tells the two
  directions apart.
- **Not every transport can carry every method.** A single HTTP response has no
  way back, so elicitation and sampling answer `unavailable` and
  `subscriptions/listen` is refused with a reason. A client left holding a
  request that will never speak is the worst of the available failures.
- `server/discover` must answer a client on a version we do not speak, because
  it is how that client learns which versions exist. Everything else refuses
  with `-32022`.
- `inputSchema` MUST be a JSON Schema object and MUST NOT be `null`.

## Known external defect

`docs/findings/001` records that Claude Code 2.1.237 accepts `server/discover`
and then reports `tools fetch failed` on a valid `tools/list`, while the
identical descriptor behind a `2025-11-25` `initialize` handshake is accepted.
That is a host bug, reproducible with a twenty-line server. If a change here
seems to break Claude Code, check that finding before assuming it is this code.

## Related

The book that this grew out of is `../mcp_cookbook`, pinned to the same
protocol version. Its `conformance/musts.json` ledger classifies all 85
server-directed MUSTs in the specification and is worth consulting before
claiming something is or is not required.
