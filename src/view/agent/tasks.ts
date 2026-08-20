/** Work the agent is doing, and the ability to stop it.
 *
 * Two rules, both learned from getting them wrong. Progress must not roll back
 * to zero on cancellation: three of five steps did happen, and saying
 * otherwise is a lie about the state of the world. And a cancelled task must
 * say what was completed and not rolled back, because that is the question the
 * reader actually has.
 */
import { computed, signal, type Signal } from "../reactive.js";
import { h, list } from "../dom.js";

export type TaskState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Task {
  id: string;
  name: string;
  state: TaskState;
  /** Zero to one hundred. Never rolled back. */
  percent: number;
  /** The last few lines of what it did. */
  steps?: string[];
  /** Shown when the task failed or was stopped part way. */
  detail?: string;
}

export interface TaskListOptions {
  tasks: Signal<readonly Task[]>;
  onCancel?: (task: Task) => void | Promise<void>;
  onRetry?: (task: Task) => void | Promise<void>;
  /** How often the summary is spoken. A line each is unusable. */
  announceEveryMs?: number;
  label?: string;
}

export interface TaskList {
  el: HTMLElement;
  running: Signal<number>;
}

const STOPPED = new Set<TaskState>(["done", "failed", "cancelled"]);

export function taskList(options: TaskListOptions): TaskList {
  const { tasks, onCancel, onRetry, announceEveryMs = 5000, label = "Tasks" } = options;
  const running = computed(() => tasks().filter((t) => t.state === "running").length);

  // Off, and announced on a schedule instead. A list that speaks on every
  // progress tick is unusable the moment more than one task is moving.
  const region = h("div", {
    class: "sr-only", role: "status", "aria-live": "polite", "aria-atomic": "true",
  });
  let lastSpoken = "";
  setInterval(() => {
    const current = tasks();
    if (!current.length) return;
    const done = current.filter((t) => t.state === "done").length;
    const failed = current.filter((t) => t.state === "failed").length;
    const summary = `${running()} running, ${done} done`
      + (failed ? `, ${failed} failed` : "");
    if (summary === lastSpoken) return;
    lastSpoken = summary;
    region.textContent = summary;
  }, announceEveryMs);

  const items = h("ul", { class: "tasks", "aria-label": label });
  items.appendChild(list<Task>(tasks, (task) => h("li", {
    class: `task task-${task.state}`,
    "data-id": task.id,
  },
    h("div", { class: "task-head" },
      h("span", { class: "task-name", text: task.name }),
      h("span", { class: `chip task-state`, text: task.state })),
    h("div", {
      class: "task-bar",
      role: "progressbar",
      "aria-valuenow": String(Math.round(task.percent)),
      "aria-valuemin": "0",
      "aria-valuemax": "100",
      "aria-label": `${task.name} progress`,
    }, h("span", { style: { width: `${Math.max(0, Math.min(100, task.percent))}%` } })),
    task.steps?.length
      ? h("pre", { class: "task-steps", text: task.steps.slice(-3).join("\n") }) : null,
    task.detail ? h("p", { class: "task-detail", text: task.detail }) : null,
    h("div", { class: "task-actions" },
      onCancel && !STOPPED.has(task.state)
        ? h("button", {
            type: "button", class: "btn btn-quiet task-cancel", text: "Cancel",
            onclick: () => void onCancel(task),
          })
        : null,
      onRetry && (task.state === "failed" || task.state === "cancelled")
        ? h("button", {
            type: "button", class: "btn btn-quiet task-retry", text: "Retry",
            onclick: () => void onRetry(task),
          })
        : null))));

  return { el: h("div", { class: "task-list" }, items, region), running };
}

export interface StreamOptions {
  /** Announced every so often rather than on every line. */
  announceEveryMs?: number;
  /** Lines kept before the oldest are dropped. */
  max?: number;
  label?: string;
}

export interface Stream {
  el: HTMLElement;
  append(text: string, kind?: "info" | "warn" | "error"): void;
  clear(): void;
  /** Following stops when the reader scrolls up, and is not resumed for them. */
  following: Signal<boolean>;
  count: Signal<number>;
}

/** Output arriving faster than anyone can read it. */
export function stream(options: StreamOptions = {}): Stream {
  const { announceEveryMs = 5000, max = 500, label = "Output" } = options;
  const following = signal(true);
  const count = signal(0);
  let sinceSpoken = 0;
  let errorsSinceSpoken = 0;

  const lines = h("div", {
    class: "stream-lines",
    // Not a live region. At five lines a second a polite region reads
    // everything aloud and the reader can do nothing else.
    "aria-live": "off",
    role: "log",
    tabindex: "0",
    "aria-label": label,
    onscroll: (event: Event) => {
      const el = event.target as HTMLElement;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
      // Scrolling up stops following. Scrolling back down does not resume it:
      // the reader is reading, and yanking them to the end is the bug.
      if (!atBottom) following.set(false);
    },
  });

  const region = h("div", {
    class: "sr-only", role: "status", "aria-live": "polite", "aria-atomic": "true",
  });

  setInterval(() => {
    if (!sinceSpoken) return;
    const errors = errorsSinceSpoken
      ? `, ${errorsSinceSpoken} error${errorsSinceSpoken === 1 ? "" : "s"}` : "";
    region.textContent =
      `${sinceSpoken} new line${sinceSpoken === 1 ? "" : "s"}${errors}`;
    sinceSpoken = 0;
    errorsSinceSpoken = 0;
  }, announceEveryMs);

  const el = h("div", { class: "stream" },
    lines,
    h("label", { class: "stream-follow" },
      h("input", {
        type: "checkbox", checked: true,
        onchange: (event: Event) =>
          following.set((event.target as HTMLInputElement).checked),
      }),
      " Follow"),
    region);

  return {
    el, following, count,
    append(text, kind = "info") {
      lines.appendChild(h("div", { class: `stream-line stream-${kind}`, text }));
      while (lines.children.length > max) lines.removeChild(lines.firstChild!);
      count.set(lines.children.length);
      sinceSpoken += 1;
      if (kind === "error") errorsSinceSpoken += 1;
      if (following.peek()) lines.scrollTop = lines.scrollHeight;
    },
    clear() { lines.replaceChildren(); count.set(0); },
  };
}
