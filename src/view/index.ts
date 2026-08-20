/** The view half: what runs inside the frame.
 *
 * Kept out of the package root because it touches the DOM and a server does
 * not. Import it from `@churning_mcp/server/view`.
 */
export { client, fakeBridge, ToolError } from "./client.js";
export { hostBridge } from "./bridge.js";
export type { HostBridgeOptions } from "./bridge.js";
export type { Client, Bridge, ClientOptions } from "./client.js";
export type {
  ToolContract, Contracts, InputOf, OutputOf, ViewProps,
} from "../contract/define.js";
export { signal, computed, effect, batch, untracked } from "./reactive.js";
export type { Signal } from "./reactive.js";
export { h, list, read, append } from "./dom.js";
export type { Reactive, Props, Child } from "./dom.js";
export { dataTable } from "./panes/data-table.js";
export { metric } from "./panes/metric.js";
export type { Metric, MetricOptions, MetricState } from "./panes/metric.js";
export { toaster, banner } from "./notify/index.js";
export type { Toaster, Banner, Severity, ToastOptions, BannerOptions } from "./notify/index.js";
export { button } from "./widgets/button.js";
export type { Button, ButtonOptions, ButtonVariant } from "./widgets/button.js";
export { form } from "./widgets/form.js";
export {
  stack, row, spacer, divider, columns, card, tabs, dialog,
} from "./layout/index.js";
export { proposal } from "./agent/proposal.js";
export type { Proposal, ProposalOptions } from "./agent/proposal.js";
export { approvalCard } from "./agent/approval.js";
export type {
  Approval, ApprovalOptions, ApprovalRequest, Provenance, Risk,
} from "./agent/approval.js";
export { taskList, stream } from "./agent/tasks.js";
export type {
  TaskList, TaskListOptions, Task, TaskState, Stream, StreamOptions,
} from "./agent/tasks.js";
export type {
  StackOptions, ColumnsOptions, CardOptions, Tab, Tabs, TabsOptions,
  Dialog, DialogOptions, Gap, Align,
} from "./layout/index.js";
export type { Form, FormOptions, Field, FieldType } from "./widgets/form.js";
export type {
  DataTable, DataTableOptions, Column, Row, SortDirection,
} from "./panes/data-table.js";
