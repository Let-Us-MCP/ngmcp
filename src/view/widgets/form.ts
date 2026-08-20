/** A form an agent may fill in and only a person may submit.
 *
 * The rule this exists to enforce: prefilling is not submitting. An agent that
 * can populate a refund form and press the button has been handed the
 * decision, and the human review the form represents has become theatre.
 * `prefill` therefore never submits, marks what it touched, and says so.
 *
 * Submission is wired by hand rather than through the form's own event. The
 * MCP Apps sandbox is `allow-scripts` and `allow-same-origin`, with no
 * `allow-forms`, so a submit button inside a view produces only a console
 * message from the browser:
 *
 *   Blocked form submission because the form's frame is sandboxed and the
 *   'allow-forms' permission is not set.
 *
 * The `submit` event never fires, so there is nothing to intercept. The
 * `<form>` element stays for its semantics and label association; the button
 * is an ordinary button and Enter is handled explicitly.
 */
import { computed, signal, type Signal } from "../reactive.js";
import { h } from "../dom.js";

export type FieldType =
  | "text" | "textarea" | "number" | "email" | "password"
  | "date" | "time" | "checkbox" | "select";

export interface Field {
  name: string;
  label: string;
  type?: FieldType;
  required?: boolean;
  placeholder?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
  /** Return a message to reject, or nothing to accept. */
  validate?: (value: unknown, values: Record<string, unknown>) => string | void;
}

export interface FormOptions {
  fields: Field[];
  onSubmit: (values: Record<string, unknown>) => void | Promise<void>;
  submitLabel?: string;
  /** Shown above the fields when an agent has filled some in. */
  prefillNotice?: string;
}

export interface Form {
  el: HTMLElement;
  values: Signal<Record<string, unknown>>;
  /** Fill fields without submitting. Always. */
  prefill(values: Record<string, unknown>, source?: string): void;
  /** Names an agent last touched, so the reader can see what to check. */
  prefilled: Signal<readonly string[]>;
  submitting: Signal<boolean>;
  errors: Signal<Record<string, string>>;
  reset(): void;
}

export function form(options: FormOptions): Form {
  const { fields, submitLabel = "Submit" } = options;
  const values = signal<Record<string, unknown>>(
    Object.fromEntries(fields.map((f) => [f.name, f.type === "checkbox" ? false : ""])));
  const errors = signal<Record<string, string>>({});
  const prefilled = signal<readonly string[]>([]);
  const submitting = signal(false);
  const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();

  const notice = h("p", {
    class: "form-notice",
    role: "status",
    hidden: computed(() => prefilled().length === 0),
    text: computed(() => {
      const names = prefilled();
      if (!names.length) return "";
      const labels = names
        .map((n) => fields.find((f) => f.name === n)?.label ?? n)
        .join(", ");
      return `${options.prefillNotice ?? "Filled in for you, not submitted"}: ${labels}. Check before submitting.`;
    }),
  });

  function validate(): boolean {
    const current = values();
    const found: Record<string, string> = {};
    for (const field of fields) {
      const value = current[field.name];
      if (field.required && (value === "" || value === null || value === undefined)) {
        found[field.name] = `${field.label} is required.`;
        continue;
      }
      const message = field.validate?.(value, current);
      if (message) found[field.name] = message;
    }
    errors.set(found);
    return Object.keys(found).length === 0;
  }

  const rows = fields.map((field) => {
    const type = field.type ?? "text";
    const id = `f-${field.name}`;
    const errorId = `${id}-error`;
    const helpId = `${id}-help`;

    const onInput = (event: Event) => {
      const target = event.target as HTMLInputElement;
      const value = type === "checkbox" ? target.checked : target.value;
      values.update((previous) => ({ ...previous, [field.name]: value }));
      // Touching a field by hand clears its agent mark: it is yours now.
      prefilled.update((previous) => previous.filter((n) => n !== field.name));
    };

    const common = {
      id,
      name: field.name,
      "aria-invalid": computed(() => (errors()[field.name] ? "true" : "false")),
      "aria-describedby": computed(() => {
        const parts = [];
        if (field.help) parts.push(helpId);
        if (errors()[field.name]) parts.push(errorId);
        return parts.length ? parts.join(" ") : null;
      }),
      "data-prefilled": computed(() =>
        prefilled().includes(field.name) ? "true" : null),
      oninput: onInput,
      onchange: onInput,
    };

    let control: HTMLElement;
    if (type === "textarea") {
      control = h("textarea", { ...common, placeholder: field.placeholder, rows: 3 });
    } else if (type === "select") {
      control = h("select", common,
        ...(field.options ?? []).map((o) =>
          h("option", { value: o.value }, o.label)));
    } else {
      control = h("input", { ...common, type, placeholder: field.placeholder });
    }
    inputs.set(field.name, control as HTMLInputElement);

    return h("div", { class: "field" },
      h("label", { for: id, text: field.label }),
      control,
      field.help ? h("span", { class: "field-help", id: helpId, text: field.help }) : null,
      h("span", {
        class: "field-error", id: errorId, role: "status",
        text: computed(() => errors()[field.name] ?? ""),
        hidden: computed(() => !errors()[field.name]),
      }));
  });

  async function trySubmit(): Promise<void> {
    if (submitting() || !validate()) return;
    submitting.set(true);
    try {
      await options.onSubmit(values());
    } finally {
      submitting.set(false);
    }
  }

  const submit = h("button", {
    // Not `type="submit"`: the sandbox blocks native submission outright.
    type: "button",
    class: "btn btn-primary",
    text: submitLabel,
    disabled: computed(() => submitting()),
    "aria-busy": computed(() => (submitting() ? "true" : "false")),
    onclick: () => void trySubmit(),
  });

  const el = h("form", {
    class: "form",
    novalidate: true,
    // Enter in a single-line field is the convention a native form gives for
    // free. It has to be put back by hand here.
    onkeydown: (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      const target = event.target as HTMLElement;
      if (target instanceof HTMLTextAreaElement) return;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
      event.preventDefault();
      void trySubmit();
    },
  }, notice, ...rows, h("div", { class: "form-actions" }, submit));

  return {
    el, values, prefilled, submitting, errors,
    prefill(next, _source) {
      const touched: string[] = [];
      for (const [name, value] of Object.entries(next)) {
        if (!inputs.has(name)) continue;
        const control = inputs.get(name) as HTMLInputElement;
        if (control.type === "checkbox") control.checked = Boolean(value);
        else control.value = String(value);
        values.update((previous) => ({ ...previous, [name]: value }));
        touched.push(name);
      }
      prefilled.set(touched);
      // Deliberately nothing else. No submit, no focus grab, no validation
      // pass that might look like approval.
    },
    reset() {
      for (const field of fields) {
        const control = inputs.get(field.name) as HTMLInputElement | undefined;
        if (!control) continue;
        if (control.type === "checkbox") control.checked = false;
        else control.value = "";
      }
      values.set(Object.fromEntries(
        fields.map((f) => [f.name, f.type === "checkbox" ? false : ""])));
      errors.set({});
      prefilled.set([]);
    },
  };
}
