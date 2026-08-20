# What Panel gets right, and what of it transfers

Panel is the closest existing thing to what an MCP app library should be. Not
because of its component count, but because of five decisions it made about
how components relate to data. This is what those decisions are, and which of
them survive the move into a sandboxed frame next to a language model.

## 1. Reactivity instead of rerun

Streamlit reruns the script top to bottom on every interaction. Panel runs the
script once and reruns only the functions whose declared dependencies changed.

This is the decision everything else rests on, and it is not a preference
here, it is forced. A view lives in a frame for the length of a conversation.
Rerunning it means re-calling tools, and a tool call crosses a process
boundary to a server that may be on a different machine. Sorting a table
cannot cost a round trip. Panel's model is the only one of the two that can
express "this changed, that did not".

**Transfers whole.** The mechanism differs, signals rather than Param, but the
principle is identical: declare what depends on what, recompute the minimum.

## 2. Pane, Widget, Layout

Panel splits components three ways, and the split is sharper than it looks.

- A **Pane** renders an object it did not create. `DataFrame`, `Plotly`,
  `Markdown`, `PDF`. It knows a shape, not a source.
- A **Widget** holds input state and emits changes. `Select`, `Slider`,
  `FileInput`.
- A **Layout** arranges other components and holds no data. `Row`, `Tabs`,
  `GridSpec`.

For MCP this maps almost too neatly. A tool returns `structuredContent`, which
is an object. A Pane renders it. The tool does not know how it will be drawn
and the Pane does not know which tool produced it, so **one tool's output can
be rendered by any Pane that fits its shape**. Rows can be a table, a chart,
or a map, chosen by the view or by the reader, without the server changing.

That is worth building for deliberately: **Panes keyed by data shape, not by
tool.** It is the difference between a library and a set of bespoke views.

**Transfers whole**, with one addition below.

## 3. Content is not presentation

A Panel Pane wraps an object that has no idea it is being displayed. A
DataFrame is a DataFrame whether it is in a notebook, a dashboard or a test.

The equivalent discipline: `structuredContent` is data, and carries no display
instruction. No `{"chartType": "bar"}` in a tool result. The moment a server
starts describing presentation, every host has to agree on the vocabulary, and
the server is now coupled to a rendering it cannot see.

**Transfers whole, and matters more here than in Panel**, because in Panel the
author owns both ends. Here the host owns the rendering surface.

## 4. Several APIs, no single correct one

Panel offers reactive binding, declarative parameter classes, and plain
callbacks, on the stated view that there is no one right way to build an app.

The MCP analogue is a different axis but the same tolerance. A view is written
either **declaratively**, where a tool names the view that renders it, or
**imperatively**, where the view calls tools as the reader interacts. Both are
legitimate: a dashboard panel is declarative, a file browser is imperative.

**Transfers, narrowed.** Three APIs for the same thing is a maintenance
burden. Two modes for two genuinely different situations is not.

## 5. The same code in every environment

Panel runs the same app in a notebook, on a server, and in the browser through
WASM, and treats that as a first-class goal rather than a porting exercise.

The MCP version of that goal is **the same view in every host**: Claude,
ChatGPT, VS Code Copilot, Goose. That is not a convenience, it is the entire
promise of MCP Apps being a standard, and it is the thing nobody currently
verifies. It is also the hardest, because hosts differ in which capabilities
they grant and what they do when refusing.

**Transfers as an obligation rather than a feature.** It is why every
component needs its granted, absent and refused behaviour, and why the tests
run in more than one engine.

---

## What does not transfer

**Panel owns its runtime. We do not.** Param's dependency tracking assumes a
Python process the author controls. A view is HTML in an opaque-origin frame
inside somebody else's product, with a restrictive CSP and no shared origin.
Every convenience that assumes a server on the same side of the boundary has
to be rebuilt or dropped.

**Panel has no host that can say no.** There is no equivalent of `downloadFile`
being advertised and then refused. Panel components have one state; MCP
components have three.

**Panel has one caller. We have two.** Every widget in an MCP app is operated
by a person *and* by a model. That is the single largest addition to the
Pane/Widget/Layout taxonomy: a Widget must expose its operation as a
registered tool, and prefilling from the agent must never submit. Panel has no
reason to have thought about this and no vocabulary for it.

**Panel has no notion of what the model is told.** A Pane renders for a human.
An MCP component renders for a human and simultaneously decides what sentence
reaches the model. Getting that wrong is how an app becomes expensive: the
table goes to the view, the summary goes to the model, and the component is
the thing that knows the difference.

## The taxonomy this leaves

Four kinds, where Panel has three:

| Kind | Holds | Answers to |
|---|---|---|
| **Pane** | nothing; renders a shape | the data |
| **Widget** | input state | a person **and** an agent |
| **Layout** | nothing; arranges | the host's size and display mode |
| **Surface** | the host relationship | capabilities, teardown, context |

`Surface` is the one with no Panel equivalent: display mode, safe-area,
theme, locale, teardown, and what to do when a capability is withdrawn
mid-session. It is not a component so much as the ground every component
stands on, and it is where MCP-specific behaviour concentrates.
