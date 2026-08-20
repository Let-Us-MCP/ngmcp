/** The view half: what runs inside the frame.
 *
 * Kept out of the package root because it touches the DOM and a server does
 * not. Import it from `@churning_mcp/server/view`.
 */
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
export type {
  StackOptions, ColumnsOptions, CardOptions, Tab, Tabs, TabsOptions,
  Dialog, DialogOptions, Gap, Align,
} from "./layout/index.js";
export type { Form, FormOptions, Field, FieldType } from "./widgets/form.js";
export type {
  DataTable, DataTableOptions, Column, Row, SortDirection,
} from "./panes/data-table.js";
