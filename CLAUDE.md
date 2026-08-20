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

## The component library

`src/view/` is the half that runs inside the frame. Four kinds, following
Panel's taxonomy with one addition, and the reasoning is in `PHILOSOPHY.md`:

- **Pane** renders a shape and knows nothing about its source. `dataTable`
  draws any list of objects; the same rows could be a chart instead.
- **Widget** holds input state and answers to a person **and** an agent.
- **Layout** arranges and holds no data, but answers to the host's size and
  display mode.
- **Surface** is the host relationship itself. Not built yet.

Every component carries four properties, or it does not land:

1. Three host states where a capability is involved: granted, absent, refused.
   Silence on refusal is the failure this is for.
2. A keyboard route. Always.
3. Accessibility asserted, not claimed.
4. Its own tests, and the mutant they must kill.

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

## Two rules in the reactive core

- **`set` stores, `update` derives.** `set` never interprets a function
  argument, because a signal has to be able to hold one: a `computed` that
  returns a formatter is a normal thing to want. Use `update(fn)` to derive
  from the previous value.
- **A view must be bundled.** Nothing can be fetched inside a `ui://` frame,
  so `bundleView()` inlines everything. `esbuild` is a development dependency,
  imported lazily, so the server runtime keeps no dependencies.

## Things that are easy to get wrong

- A handler doing `await new Promise(r => ctx.signal.addEventListener("abort", r))`
  never returns if the signal already fired. The runtime refuses to start a
  handler whose request is already cancelled, and that protection has both a
  guard and a regression test with a repeat count. Do not remove either.
- Progress with no `progressToken` invents a correlation the client cannot
  use. Nothing after the response, ever.
- `-32002` is retired and forbidden in this version. A missing resource is
  `-32602`, and never an empty `contents` array.
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
