/** Deciding, with enough in front of you to decide.
 *
 * An approval that shows only "Allow this action?" is a rubber stamp with
 * extra steps. What makes it a decision is the provenance: who asked, on
 * whose behalf, through which tool, with which arguments, and what has been
 * approved before. All of that is required rather than optional, because a
 * card that permits leaving it out will be built without it.
 */
import { computed, signal, type Signal } from "../reactive.js";
import { h } from "../dom.js";

export type Risk = "low" | "medium" | "high";

export interface Provenance {
  /** Who initiated it, in words a person can check. */
  askedBy: string;
  /** The human on whose behalf, if any. */
  onBehalfOf?: string;
  tool: string;
  /** Shown verbatim. This is the thing being approved. */
  arguments: string;
  priorApprovals?: string;
  [key: string]: string | undefined;
}

export interface ApprovalRequest {
  id: string;
  title: string;
  risk: Risk;
  /** What happens if this is approved, in plain terms. */
  consequence: string;
  description?: string;
  provenance: Provenance;
  at?: string;
}

export interface ApprovalOptions {
  request: ApprovalRequest;
  onDecide: (decision: "approved" | "denied", request: ApprovalRequest)
    => void | Promise<void>;
  approveLabel?: string;
  denyLabel?: string;
  /** High-risk requests require the title typed back. Default true. */
  confirmHighRisk?: boolean;
}

export interface Approval {
  el: HTMLElement;
  decision: Signal<"approved" | "denied" | null>;
  /** Decide from elsewhere: a keyboard shortcut, a queue, a bulk control.
   *
   * Exposed deliberately. Without it the only route to a decision is a button
   * that disables itself, and the guard against deciding twice is unreachable
   * and therefore untestable. A decision that can be reached from more than
   * one place needs the guard to live in the decision, not in the button. */
  decide(what: "approved" | "denied"): Promise<void>;
}

export function approvalCard(options: ApprovalOptions): Approval {
  const {
    request, approveLabel = "Approve", denyLabel = "Deny",
    confirmHighRisk = true,
  } = options;
  const decision = signal<"approved" | "denied" | null>(null);
  const busy = signal(false);
  const typed = signal("");

  const needsConfirmation = confirmHighRisk && request.risk === "high";
  const canApprove = computed(() =>
    !busy() && decision() === null
    && (!needsConfirmation || typed().trim() === request.title));

  async function decide(what: "approved" | "denied"): Promise<void> {
    // Once decided, never again. The record of what happened has to stay true
    // even if a second route to this function exists.
    if (busy.peek() || decision.peek() !== null) return;
    busy.set(true);
    try {
      await options.onDecide(what, request);
      decision.set(what);
    } finally {
      busy.set(false);
    }
  }

  const provenanceRows = Object.entries(request.provenance)
    .filter(([, value]) => value !== undefined)
    .flatMap(([key, value]) => [
      h("dt", { text: key.replace(/([A-Z])/g, " $1").toLowerCase() }),
      h("dd", { text: String(value) }),
    ]);

  const el = h("article", {
    class: computed(() =>
      `approval risk-${request.risk}${decision() ? " decided" : ""}`),
    "aria-label": `${request.title}, ${request.risk} risk`,
  },
    h("header", { class: "approval-head" },
      h("h2", { class: "approval-title", text: request.title }),
      h("span", { class: `chip risk-${request.risk}`, text: `${request.risk} risk` })),
    request.description
      ? h("p", { class: "approval-description", text: request.description }) : null,
    // The consequence is not optional and is not buried. It is the thing a
    // person is actually agreeing to.
    h("p", { class: "approval-consequence", text: request.consequence }),
    h("dl", { class: "approval-provenance" }, ...provenanceRows),
    needsConfirmation
      ? h("div", { class: "approval-confirm" },
          h("label", {
            for: `confirm-${request.id}`,
            text: `Type the title to approve: ${request.title}`,
          }),
          h("input", {
            id: `confirm-${request.id}`, type: "text",
            autocomplete: "off",
            oninput: (event: Event) =>
              typed.set((event.target as HTMLInputElement).value),
          }))
      : null,
    h("div", { class: "approval-actions" },
      h("button", {
        type: "button", class: "btn btn-primary approval-approve",
        text: approveLabel,
        disabled: computed(() => !canApprove()),
        onclick: () => void decide("approved"),
      }),
      h("button", {
        type: "button", class: "btn btn-quiet approval-deny",
        text: denyLabel,
        disabled: computed(() => busy() || decision() !== null),
        onclick: () => void decide("denied"),
      })),
    h("p", {
      class: "approval-outcome", role: "status",
      hidden: computed(() => decision() === null),
      text: computed(() => (decision() ? `${request.title}: ${decision()}` : "")),
    }));

  return { el, decision, decide };
}
