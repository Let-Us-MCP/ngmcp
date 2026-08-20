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
export type {
  DataTable, DataTableOptions, Column, Row, SortDirection,
} from "./panes/data-table.js";
