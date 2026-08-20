# The floor

## Why anyone reaches for an MCP app

A tool answers twice. `content` carries a sentence for the model;
`structuredContent` carries the data. Without a view, the second half has
nowhere to go, so the data gets flattened into the sentence and the model is
handed a table it has to describe in prose.

People reach for MCP apps to stop doing that. The app **is** the structured
response: eight deployments become a table that sorts, a month of latency
becomes a line, an approval becomes a card with the provenance attached. Text
is what you fall back to when the host cannot render, not the destination.

Everything below follows from taking that seriously. If an app is a structured
response, the ceiling on the response is the expressiveness of the component
library, and today that ceiling is a `<table>` somebody hand-rolled. A
dashboard is the limit case: many structured responses, composed, persisting
across turns.

## What the floor is

What an MCP app template library has to contain before it is worth choosing
over writing the thing yourself. Four sources, each supplying a different
kind of obligation.

**`@modelcontextprotocol/ext-apps`** supplies the wire. It is a transport and
a theme adapter: an `App` bridge with 24 methods, 4 server helpers, 6 React
hooks and 4 style functions. It ships **no components at all**. Anything the
library builds has to speak this bridge or stay compatible with it, because at
2.75M downloads a week it is the thing hosts already implement.

**The MCP UI Cookbook** supplies the map: 88 capabilities across 25 groups, 13
recipe applications that compose them, and a conformance suite that decides
whether a host really supports what it claims. It says what an MCP app must
survive, including every way a host can refuse.

**Streamlit** supplies the expectations. It is the reference for what somebody
building a data application assumes already exists. A developer who has used
it will look for a chart, a form, tabs and a file uploader on day one, and
notice their absence immediately.

**HoloViz Panel** supplies the ambition, and the architecture. It is what a
serious dashboard framework contains: roughly 35 panes, 60 widgets, 18
layouts, 9 indicators, 9 templates and a chat stack. More importantly it is
built the right way round for this problem.

## Why Panel is the model and Streamlit is only the checklist

Streamlit reruns the whole script on every interaction. A view cannot work
that way. It lives in a frame for the length of a conversation, its state is
local by design, and rerunning means re-calling tools, which is precisely the
boundary crossing that makes an app feel slow and cost money.

Panel is object based and reactive. Components hold their own state,
parameters change, and only what depends on them updates. That is what a
long-lived view in a sandboxed frame actually does, so Panel's model maps onto
an MCP app with nothing lost in translation. Its `.servable()` is already the
shape of `_meta.ui.resourceUri`: an object a server serves.

Take the widget list from Streamlit and the architecture from Panel.

The floor is the union. Nothing below is speculative: each line is demanded by
at least one of the four, and the provenance says which.

---

## 1. Bridge

Not rebuilt. Wrapped, or used directly.

| Need | Source |
|---|---|
| `callServerTool`, `readServerResource`, `listServerResources` | ext-apps |
| `updateModelContext`, `sendMessage` | ext-apps, cookbook `agent` |
| `downloadFile`, `openLink` | ext-apps, cookbook `file`, `link` |
| `requestDisplayMode`, `sendSizeChanged` | ext-apps, cookbook `surface` |
| `requestTeardown` and the teardown handshake | ext-apps, cookbook `lifecycle` |
| `createSamplingMessage` | ext-apps, cookbook `agent` |
| `sendLog` | ext-apps, cookbook `log` |
| Host capabilities and host context | ext-apps, cookbook `host`, `env` |

## 2. Layout

Streamlit has ten of these and the cookbook has four. A library with fewer
than this list forces every app to hand-roll its own page structure.

`Stack` · `Row` · `Columns` · `Container` · `Card` · `Tabs` · `Expander` ·
`Popover` · `Dialog` · `Sidebar` · `Bottom` · `Spacer` · `Divider` · `Toolbar`

Two the cookbook adds and Streamlit has no reason to: layout that responds to
**display mode** (inline against fullscreen) and to **safe-area insets**.

## 3. Text and code

`Markdown` · `Heading` · `Caption` · `Code` · `Latex` · `Badge` · `Chip` ·
`Json` · `Help`

`Html` is deliberately absent. A view already runs in a sandboxed frame with
an opaque origin, and a component that injects arbitrary markup inside it is
the one place that boundary can be spent carelessly.

## 4. Data

The largest gap between the three sources. Streamlit's `dataframe` and
`data_editor` are what people expect; the cookbook proves what they must do
under an agent.

| Component | Must do |
|---|---|
| `DataTable` | sort, filter, page and select **locally**, no tool call |
| `DataEditor` | edit in place, dirty state, save that never lies about failing |
| `ColumnConfig` | per-column type, format, width, editability |
| `Grid` | formula cells showing values rather than formulas |
| `Table` | static, no interaction |
| `Metric` | value, unit, delta, state colour |
| `Tree` | one tab stop, arrow-key navigation, context menu |
| `DiffView` | added, removed and context lines, line selection |
| `NodeGraph` | pan, zoom, and connecting nodes without a pointer |
| `Pagination` | cursor-based, since MCP list results are cursor-based |

## 5. Charts

The cookbook has one sparkline. Streamlit has twelve chart calls. Anyone
building a dashboard expects at least the first row.

`LineChart` · `AreaChart` · `BarChart` · `ScatterChart` · `Sparkline` ·
`Heatmap` · `Map` · `Mermaid`

Rendered as inline SVG rather than a charting dependency, because a view
declaring an external origin defeats the restrictive default CSP it ships
with.

## 6. Input

Streamlit's list, plus the two things an MCP app needs that a Streamlit app
does not: every input has to be reachable from an agent as a registered tool,
and prefill must never submit on the agent's behalf.

`Button` · `DownloadButton` · `LinkButton` · `MenuButton` · `Checkbox` ·
`Toggle` · `Radio` · `Select` · `MultiSelect` · `Pills` · `SegmentedControl` ·
`Slider` · `SelectSlider` · `NumberInput` · `TextInput` · `TextArea` ·
`DateInput` · `TimeInput` · `DateTimeInput` · `ColorPicker` · `Feedback` ·
`Form` · `FileUploader` · `CameraInput` · `AudioInput`

## 7. Media and files

`Image` · `Audio` · `Video` · `Pdf` · `MediaTransport` · `Thumbstrip` ·
`Preview` · `DropZone` · `FilePicker` · `ResourcePicker`

`Preview` carries a specific obligation from the cookbook: it must be visibly
an image and not a placeholder, at more than one size, and a failure to decode
must be visible rather than silent. That bug shipped once already.

## 8. Status and notification

`Toast` · `Banner` · `Alert` (success, info, warning, error) · `Exception` ·
`Progress` · `Spinner` · `Skeleton` · `Status` · `Announce`

`Announce` is the one Streamlit has no equivalent for and the cookbook learned
the hard way: a live region that announces every line is unusable at five
lines a second, so the component announces a **summary on an interval** and
nothing at all when nothing arrived.

`LogStream` belongs here too: `aria-live="off"`, follow that unticks on
scroll, and a selection that survives a thousand new lines.

## 9. Chat and agent

Streamlit added chat elements because that is where applications went. For an
MCP app they are not optional, because the app lives inside a conversation.

`ChatMessage` · `ChatInput` · `Stream` (token-by-token) · `TaskList` ·
`Proposal` · `ApprovalCard` · `AuditTrail` · `Provenance`

`Proposal` is the pattern the cookbook's document editor proved: the agent
proposes, the human decides, and a rewrite is shown rather than applied.
`ApprovalCard` carries who asked, on whose behalf, which tool, which
arguments, and what happened before.

## 10. Indicators

Dashboard vocabulary. Streamlit has almost none of this and Panel has nine,
which is the difference between a page of numbers and a dashboard.

`Number` · `Trend` · `Dial` · `Gauge` · `LinearGauge` · `Progress` ·
`BooleanStatus` · `LoadingSpinner` · `TooltipIcon`

## 11. Dashboard shells

The part that turns components into a dashboard, and the reason this library
exists rather than a widget set. Panel ships nine templates; the equivalent
here is fewer and stricter, because a view has to survive being resized by a
host and switched between inline and fullscreen.

`ListTemplate` (header, sidebar, main) · `GridTemplate` · `TabbedTemplate` ·
`SlidesTemplate` · `GridStack` (draggable, resizable panels) · `GridSpec` ·
`Feed` (an appending stream, virtualised) · `FloatPanel` · `Modal`

A dashboard shell carries obligations a single component does not: panel
layout persisted through a server-minted handle, per-panel refresh that does
not re-fetch the whole board, and a layout that degrades to one column when
the host gives it 320 pixels.

## 12. State and flow

`SessionState` (local to the view, which is where MCP state now lives) ·
`QueryParams` · `Fragment` · `Form` · `CacheData` · `Rerun`

The protocol removed sessions in `2026-07-28`, so cross-call state is an
explicit server-minted handle. The library should make the local-first split
the default rather than an option: sorting, filtering, paging and selecting
never cross the boundary unless asked.

---

## What makes it a superset rather than a bigger widget set

Streamlit runs on a server it trusts, in a browser it controls. An MCP app
runs in a sandboxed frame inside somebody else's product, next to a language
model. Four properties therefore attach to **every** component above, and
none of the three sources provides them:

1. **Three host states, not one.** Anything depending on a host capability
   ships `granted`, `absent` and `refused` behaviour. Silence on refusal is
   the default failure; the cookbook's harness found an export button that did
   exactly that.
2. **A keyboard route, always**, including the canvases. Two recipes only got
   one after somebody noticed.
3. **Accessibility asserted rather than claimed.** `axe` clean, plus the ARIA
   Authoring Practices keyboard checklist as executable assertions, per
   component in isolation rather than only through an app that uses it. In
   isolation is where it bites: the first run in isolation found a dialog that
   announced another dialog's title, which no application-level check would
   have separated from the application.
4. **Tests that ship with the component**, so an application inherits the
   checks instead of the prose.

Two more from the framework: the **typed contract** from a tool's output to
its view's props, so the shape is written once; and **local-first by default**.

## What a dashboard needs that a single app does not

Moving from "an app" to "a dashboard" changes the server, not only the view.
Four things become obligations:

1. **Many tools feeding many panels.** One view, several tools, each panel
   refreshing on its own schedule without re-fetching the board.
2. **Refresh without a conversation turn.** Progress notifications already
   flow against a running request; a dashboard needs a panel to update without
   the model being involved at all.
3. **Layout as state.** Which panels, where, at what size. The protocol has no
   sessions, so this is a server-minted handle passed as a tool argument.
4. **Composition across servers.** The interesting dashboard shows deployments
   from one server next to incidents from another. Nothing in the extension
   describes that today, and it is the largest thing missing.

That fourth one is the real ceiling. Everything above it is buildable now.

**All four are now built**, and the fourth turned out to be short rather than
hard, for a reason that belongs to this protocol version rather than to any
cleverness here: a request carries its own version and capabilities, so
forwarding one is copying it. `compose()` mounts several servers behind one,
namespaces their tools and their view uris, forwards the caller's own `_meta`
so an upstream decides on the real client, and reports an upstream it could not
reach rather than quietly returning a shorter list. Under a session-shaped
protocol the same file would be a connection manager, and it would have to
replay a handshake it cannot honestly make.

`examples/gallery/` is all of it at once: seven screens, a board fed by two
servers behind a gateway, and a checklist a person grades out loud so the
claim is something somebody looked at rather than a test result.

## Built so far

| Kind | Component | Notes |
|---|---|---|
| Pane | `dataTable` | local sort, filter, page, select |
| Pane | `metric` | locale from the host, delta coloured by meaning |
| Widget | `button` | granted, absent with fallback, refused |
| Widget | `form` | prefill never submits, and is marked |
| Notify | `toaster` | a burst becomes one announcement |
| Notify | `banner` | a condition, not an event |
| Layout | `stack`, `row`, `spacer`, `divider` | |
| Layout | `columns` | collapses on the frame's width, not the viewport's |
| Layout | `card` | names itself for a dashboard of many |
| Layout | `tabs` | ARIA practice, arrows, Home and End, lazy panels |
| Layout | `dialog` | native `<dialog>`, which works in the sandbox |
| Agent | `proposal` | the agent proposes, the person decides; no auto-apply |
| Agent | `approvalCard` | provenance required, high risk types the title back |
| Agent | `taskList` | progress that does not roll back on cancellation |
| Agent | `stream` | `aria-live="off"` plus a summary on an interval |
| Pane | `lineChart`, `areaChart`, `barChart`, `scatterChart` | inline SVG, keyboard route through the points |
| Pane | `sparkline` | a line the size of a word, with its numbers behind it |
| Pane | `heatmap` | every cell carries its number as well as its shade |
| Shell | `listTemplate` | header, sidebar, main, with the landmarks a page has |
| Shell | `gridStack` | panels that refresh apart, layout as a value, one column at 320 |
| Surface | `surface` | granted, absent, refused; insets, display mode, teardown |
| Surface | `hostBridge` | postMessage, ids correlated, order not assumed |

Each of them is mounted alone and run through `axe` in both engines, and five
mutants stand behind that suite so it cannot pass by not looking: an unnamed
filter, a label bound to nothing, an unnamed dismiss button, an unnamed
progress bar, and an unlabelled high-risk confirmation.

Three sandbox facts established by probing rather than assumption:
`<form>` submission is blocked in Chromium and fires in WebKit, so it is
unusable either way; `showModal()` works in both, because `allow-modals`
governs `alert` and `confirm` rather than `<dialog>`; and `Intl.NumberFormat()`
with no locale renders 1234567 as `1,234,567` in one engine and `12,34,567` in
the other.

## Order

The floor is roughly 110 components, which is a year, not a sprint. The order
that gets something usable soonest:

1. ~~`DataTable`, `Metric`, `Toast`, `Banner`, `Button`, `Form`~~ done.
2. ~~Layout: `Stack`, `Columns`, `Tabs`, `Card`, `Dialog`~~ done.
   ~~Agent: `Proposal`, `ApprovalCard`, `TaskList`, `Stream`~~ done.
3. ~~Charts, starting with `LineChart` and `Sparkline`~~ done, less `Map` and
   `Mermaid`: one needs a projection and the other a parser.
4. ~~`ListTemplate` and `GridStack`, at which point it is a dashboard rather
   than a page~~ done, along with the Surface and the four protocol methods
   that were missing.
5. Everything else, by demand.

Each one lands with its three host states, its keyboard route, its axe
assertion and its mutant, or it does not land.
