/** `subscriptions/listen`: the long-lived stream that replaced the GET endpoint.
 *
 * A dashboard needs a panel to update without the model being involved at all,
 * and `2026-07-28` removed the HTTP GET endpoint that used to carry that. What
 * replaced it is a request that does not answer: the client sends
 * `subscriptions/listen` with a filter naming what it wants, the server
 * acknowledges, notifications flow tagged with the subscription's id, and the
 * response arrives only when the stream is torn down.
 *
 * Which makes a subscription an **in-flight request**, not a session. That
 * distinction is the whole reason this fits here at all: it is entered in the
 * same table as any other running request, a `notifications/cancelled` finds it
 * the same way, and when it ends there is nothing left behind for the next
 * request to read. A server holding a hundred subscriptions is a server with a
 * hundred requests in flight.
 *
 * Two rules from the specification that this file exists to keep:
 *
 * - The server **MUST NOT** send a notification type the client did not ask
 *   for. The filter is an allow list, not a hint.
 * - The acknowledgement **MUST** be the first message carrying the
 *   subscription's id, and it reports the subset the server actually agreed
 *   to. A client that asked for prompt changes from a server with no prompts
 *   is told that, rather than left waiting for something that cannot arrive.
 */
import type { Id, Notification } from "../protocol/jsonrpc.js";
import { META } from "../protocol/version.js";

/** The reserved `_meta` key that ties a notification to its subscription. */
export const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";

export interface SubscriptionFilter {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  /** Resource uris to be told about. Replaces the old `resources/subscribe`. */
  resourceSubscriptions?: string[];
}

/** What the server is able to honour, decided by what it actually has. */
export interface SubscriptionSupport {
  tools: boolean;
  prompts: boolean;
  resources: boolean;
}

interface Entry {
  id: Id;
  filter: SubscriptionFilter;
  close: (result: Record<string, unknown>) => void;
}

const listChangedMethod: Record<string, string> = {
  toolsListChanged: "notifications/tools/list_changed",
  promptsListChanged: "notifications/prompts/list_changed",
  resourcesListChanged: "notifications/resources/list_changed",
};

/** Narrow what was asked for to what this server can actually deliver. */
export function agreed(
  wanted: SubscriptionFilter, support: SubscriptionSupport,
): SubscriptionFilter {
  const out: SubscriptionFilter = {};
  if (wanted.toolsListChanged && support.tools) out.toolsListChanged = true;
  if (wanted.promptsListChanged && support.prompts) out.promptsListChanged = true;
  if (wanted.resourcesListChanged && support.resources) out.resourcesListChanged = true;
  if (wanted.resourceSubscriptions?.length && support.resources) {
    out.resourceSubscriptions = [...wanted.resourceSubscriptions];
  }
  return out;
}

/** The streams currently open. One entry per in-flight `subscriptions/listen`. */
export class Subscriptions {
  readonly #open = new Map<Id, Entry>();

  get size(): number { return this.#open.size; }

  /** Register a stream. The returned promise settles when it is torn down. */
  open(id: Id, filter: SubscriptionFilter): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      this.#open.set(id, { id, filter, close: resolve });
    });
  }

  /** End one stream, answering the request that opened it. */
  close(id: Id): boolean {
    const entry = this.#open.get(id);
    if (!entry) return false;
    this.#open.delete(id);
    // The result body is empty: the id in `_meta` is what the client needs, so
    // it can tell which of its subscriptions just ended.
    entry.close({ _meta: { [SUBSCRIPTION_ID]: id } });
    return true;
  }

  closeAll(): void {
    for (const id of [...this.#open.keys()]) this.close(id);
  }

  /** Every subscription that asked for this notification, tagged with its id.
   *
   * Returns one notification per interested subscription rather than one
   * broadcast, because the tag differs per subscription and a client uses it to
   * work out which of its streams a message belongs to. */
  match(method: string, params: Record<string, unknown> = {}): Notification[] {
    const out: Notification[] = [];
    for (const entry of this.#open.values()) {
      if (!wants(entry.filter, method, params)) continue;
      out.push({
        jsonrpc: "2.0",
        method,
        params: {
          ...params,
          _meta: {
            ...(params["_meta"] as Record<string, unknown> ?? {}),
            [SUBSCRIPTION_ID]: entry.id,
          },
        },
      });
    }
    return out;
  }

  /** The acknowledgement, which must be the first message on a stream. */
  acknowledgement(id: Id, filter: SubscriptionFilter): Notification {
    return {
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: { notifications: filter, _meta: { [SUBSCRIPTION_ID]: id } },
    };
  }
}

function wants(
  filter: SubscriptionFilter, method: string, params: Record<string, unknown>,
): boolean {
  for (const [key, notification] of Object.entries(listChangedMethod)) {
    if (method === notification) {
      return filter[key as keyof SubscriptionFilter] === true;
    }
  }
  if (method === "notifications/resources/updated") {
    const uri = params["uri"];
    // An empty list is not a wildcard. A client that named no resources asked
    // to be told about no resources.
    return typeof uri === "string"
      && (filter.resourceSubscriptions ?? []).includes(uri);
  }
  return false;
}

export { META };
