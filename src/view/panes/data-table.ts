/** A table that sorts, filters, pages and selects without leaving the frame.
 *
 * A Pane in Panel's sense: it renders a shape and knows nothing about where
 * the rows came from. Any tool returning a list of objects can be drawn by
 * this, and the same rows could be drawn by a chart instead without the
 * server changing.
 *
 * Everything it does is local. Sorting a column, typing in the filter and
 * turning a page never call a tool, because each of those would otherwise
 * cross a process boundary to answer a question the view can already answer.
 * Ask the server again only when the data itself should change.
 */
import { computed, signal, type Signal } from "../reactive.js";
import { h, list, read, type Reactive } from "../dom.js";

export type Row = Record<string, unknown>;
export type SortDirection = "ascending" | "descending";

export interface Column<R extends Row = Row> {
  key: string;
  label: string;
  align?: "start" | "end";
  sortable?: boolean;
  /** Turn a cell value into what the reader sees. */
  format?: (value: unknown, row: R) => string;
}

export interface DataTableOptions<R extends Row = Row> {
  rows: Reactive<readonly R[]>;
  columns: Column<R>[];
  /** Stable identity for a row. Selection survives the rows changing. */
  rowId?: (row: R) => string;
  selection?: "none" | "single" | "multiple";
  filterable?: boolean;
  pageSize?: number;
  emptyText?: string;
  filterLabel?: string;
  caption?: string;
  onSelectionChange?: (selected: R[]) => void;
}

export interface DataTable<R extends Row = Row> {
  el: HTMLElement;
  /** Ids of the selected rows, in selection order. */
  selected: Signal<readonly string[]>;
  /** The rows currently on screen, after filter, sort and paging. */
  visible: Signal<readonly R[]>;
  filter: Signal<string>;
  page: Signal<number>;
  clearSelection(): void;
}

const defaultId = (row: Row): string =>
  String(row["id"] ?? JSON.stringify(row));

const compare = (a: unknown, b: unknown): number => {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
};

export function dataTable<R extends Row = Row>(
  options: DataTableOptions<R>,
): DataTable<R> {
  const {
    columns, rowId = defaultId as (row: R) => string,
    selection = "none", filterable = true, pageSize = 0,
    emptyText = "Nothing to show.",
    filterLabel = "Filter rows",
    caption,
  } = options;

  const filter = signal("");
  const page = signal(0);
  const sortKey = signal<string | null>(null);
  const sortDirection = signal<SortDirection>("ascending");
  const selected = signal<readonly string[]>([]);

  const all = computed(() => read(options.rows));

  const filtered = computed(() => {
    const term = filter().trim().toLowerCase();
    const rows = all();
    if (!term) return rows;
    return rows.filter((row) => columns.some((column) => {
      const value = row[column.key];
      return value !== null && value !== undefined
        && String(value).toLowerCase().includes(term);
    }));
  });

  const sorted = computed(() => {
    const key = sortKey();
    const rows = filtered();
    if (!key) return rows;
    const direction = sortDirection() === "ascending" ? 1 : -1;
    return [...rows].sort((a, b) => compare(a[key], b[key]) * direction);
  });

  const pageCount = computed(() =>
    pageSize > 0 ? Math.max(1, Math.ceil(sorted().length / pageSize)) : 1);

  const visible = computed<readonly R[]>(() => {
    const rows = sorted();
    if (pageSize <= 0) return rows;
    const current = Math.min(page(), pageCount() - 1);
    return rows.slice(current * pageSize, current * pageSize + pageSize);
  });

  const isSelected = (id: string) => selected().includes(id);

  function toggle(row: R): void {
    if (selection === "none") return;
    const id = rowId(row);
    selected.set((previous) => {
      if (selection === "single") return previous[0] === id ? [] : [id];
      return previous.includes(id)
        ? previous.filter((x) => x !== id)
        : [...previous, id];
    });
    options.onSelectionChange?.(
      all().filter((r) => selected().includes(rowId(r))));
  }

  function sortBy(column: Column<R>): void {
    if (column.sortable === false) return;
    if (sortKey() === column.key) {
      sortDirection.set((d) => (d === "ascending" ? "descending" : "ascending"));
    } else {
      sortKey.set(column.key);
      sortDirection.set("ascending");
    }
    page.set(0);
  }

  const headerCells = columns.map((column) => {
    const sortState = computed(() =>
      sortKey() === column.key ? sortDirection() : "none");
    const cell = h("th", {
      scope: "col",
      "aria-sort": sortState,
      class: column.align === "end" ? "num" : null,
    });
    if (column.sortable === false) {
      cell.textContent = column.label;
      return cell;
    }
    // A button, so it is reachable and announced as an operation rather than
    // a click target that happens to be a table header.
    cell.appendChild(h("button", {
      type: "button",
      class: "sort",
      text: column.label,
      onclick: () => sortBy(column),
    }));
    return cell;
  });

  const body = h("tbody", { part: "body" });
  body.appendChild(list<R>(visible, (row) => {
    const id = rowId(row);
    const tr = h("tr", {
      "data-id": id,
      tabindex: selection === "none" ? null : "0",
      "aria-selected": selection === "none"
        ? null : computed(() => String(isSelected(id))),
      onclick: selection === "none" ? undefined : () => toggle(row),
      onkeydown: selection === "none" ? undefined : (event: KeyboardEvent) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        toggle(row);
      },
    });
    for (const column of columns) {
      const value = row[column.key];
      tr.appendChild(h("td", { class: column.align === "end" ? "num" : null },
        column.format ? column.format(value, row)
          : value === null || value === undefined ? "" : String(value)));
    }
    return tr;
  }));

  const status = h("p", {
    class: "status",
    role: "status",
    "aria-live": "polite",
    text: computed(() => {
      const shown = visible().length;
      const total = all().length;
      if (total === 0) return emptyText;
      const chosen = selected().length;
      const base = shown === total
        ? `${total} rows` : `${shown} of ${total} rows`;
      return chosen ? `${base}, ${chosen} selected` : base;
    }),
  });

  const parts: (Node | null)[] = [];

  if (filterable) {
    const input = h("input", {
      type: "search",
      class: "filter",
      "aria-label": filterLabel,
      placeholder: filterLabel,
      oninput: (event: Event) => {
        filter.set((event.target as HTMLInputElement).value);
        page.set(0);
      },
    });
    parts.push(input);
  }

  const table = h("table", { class: "data-table" },
    caption ? h("caption", { text: caption }) : null,
    h("thead", {}, h("tr", {}, ...headerCells)),
    body);
  parts.push(table, status);

  if (pageSize > 0) {
    const label = computed(() => `Page ${Math.min(page(), pageCount() - 1) + 1} of ${pageCount()}`);
    parts.push(h("div", { class: "pager" },
      h("button", {
        type: "button", text: "Previous",
        "aria-label": "Previous page",
        disabled: computed(() => page() <= 0),
        onclick: () => page.set((p) => Math.max(0, p - 1)),
      }),
      h("span", { class: "page-label", text: label }),
      h("button", {
        type: "button", text: "Next",
        "aria-label": "Next page",
        disabled: computed(() => page() >= pageCount() - 1),
        onclick: () => page.set((p) => Math.min(pageCount() - 1, p + 1)),
      })));
  }

  const el = h("div", { class: "pane data-table-pane" },
    ...parts.filter(Boolean) as Node[]);

  return {
    el, selected, visible, filter, page,
    clearSelection: () => selected.set([]),
  };
}
