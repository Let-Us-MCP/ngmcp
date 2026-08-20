/** The agent proposes. The person decides.
 *
 * The failure this prevents is an agent that edits the document directly. Once
 * it can, the review the interface implies has become decoration: by the time
 * anyone reads the change it is already the state of the world, and undo is
 * the only remaining control.
 *
 * So a proposal is shown beside what it would replace, and nothing changes
 * until someone accepts. There is deliberately no `autoAccept`.
 */
import { computed, signal, type Signal } from "../reactive.js";
import { h, read, type Reactive } from "../dom.js";

export interface ProposalOptions<T> {
  /** What the value is now. */
  current: Reactive<T>;
  /** How to show a value to a reader. */
  render: (value: T) => string;
  /** Applied only when a person accepts. */
  onAccept: (proposed: T) => void | Promise<void>;
  onReject?: (proposed: T) => void;
  acceptLabel?: string;
  rejectLabel?: string;
  /** Names the party proposing, so the reader knows who is asking. */
  proposer?: string;
}

export interface Proposal<T> {
  el: HTMLElement;
  /** Show a proposal. Never applies it. */
  propose(value: T, rationale?: string): void;
  /** The pending proposal, or null. */
  pending: Signal<{ value: T; rationale?: string } | null>;
  accept(): Promise<void>;
  reject(): void;
}

export function proposal<T>(options: ProposalOptions<T>): Proposal<T> {
  const {
    render, acceptLabel = "Accept", rejectLabel = "Reject",
    proposer = "The agent",
  } = options;
  const pending = signal<{ value: T; rationale?: string } | null>(null);
  const busy = signal(false);

  const reject = (): void => {
    const current = pending.peek();
    if (!current) return;
    pending.set(null);
    options.onReject?.(current.value);
  };

  const accept = async (): Promise<void> => {
    const current = pending.peek();
    if (!current || busy.peek()) return;
    busy.set(true);
    try {
      await options.onAccept(current.value);
      pending.set(null);
    } finally {
      busy.set(false);
    }
  };

  const el = h("div", {
    class: "proposal",
    role: "region",
    "aria-label": "Proposed change",
    hidden: computed(() => pending() === null),
  },
    h("p", {
      class: "proposal-who",
      text: computed(() => {
        const current = pending();
        return current?.rationale
          ? `${proposer} proposes: ${current.rationale}`
          : `${proposer} proposes a change.`;
      }),
    }),
    h("div", { class: "proposal-compare" },
      h("div", { class: "proposal-side proposal-current" },
        h("h3", { text: "Now" }),
        h("pre", { class: "proposal-text", text: computed(() => render(read(options.current))) })),
      h("div", { class: "proposal-side proposal-next" },
        h("h3", { text: "Proposed" }),
        h("pre", {
          class: "proposal-text",
          text: computed(() => {
            const current = pending();
            return current ? render(current.value) : "";
          }),
        }))),
    h("div", { class: "proposal-actions" },
      h("button", {
        type: "button", class: "btn btn-primary proposal-accept",
        text: acceptLabel,
        disabled: busy,
        "aria-busy": computed(() => (busy() ? "true" : "false")),
        onclick: () => void accept(),
      }),
      h("button", {
        type: "button", class: "btn btn-quiet proposal-reject",
        text: rejectLabel, disabled: busy, onclick: reject,
      })));

  return {
    el, pending, accept, reject,
    propose(value, rationale) {
      // Shown, not applied. There is no branch here that changes the value.
      pending.set(rationale === undefined ? { value } : { value, rationale });
    },
  };
}
