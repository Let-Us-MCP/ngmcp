/** Multi Round-Trip Requests: how a server asks the client for something.
 *
 * `2026-07-28` deleted server-initiated requests. A server no longer sends
 * `elicitation/create` or `sampling/createMessage` down the wire and waits for
 * an answer; the specification calls that "no longer supported" and "a
 * breaking change". What replaced it:
 *
 *   1. The client sends a request.
 *   2. The server cannot finish, and answers `resultType: "input_required"`
 *      with a map of what it needs.
 *   3. The client gathers it, and **retries the original request** with the
 *      answers in `inputResponses`.
 *   4. The server finishes and answers normally.
 *
 * The reason is the same reason this package exists. The specification says it
 * outright: this works "without requiring a shared storage layer across server
 * instances or requiring stateful load balancing". A server-initiated request
 * needs the answer to come back to the very process that asked. A round trip
 * needs nothing of the sort — the retry is an ordinary request carrying
 * everything required to answer it, and any instance can take it.
 *
 * Which changes what a handler looks like. It is **re-run from the top** on
 * the retry, with the answers now available, rather than resumed where it left
 * off. So a handler must be safe to run again up to the point where it asks —
 * read what you like, change nothing until you have the answer. That is the
 * one obligation this pattern imposes, and it is why `requestState` is
 * optional here and unused: nothing is being resumed, so there is no
 * continuation to carry.
 */

/** One thing the server is asking the client to obtain. */
export interface InputRequest {
  method: "elicitation/create" | "sampling/createMessage" | "roots/list" | string;
  params: Record<string, unknown>;
}

/** What the server asks for, keyed by names it chose. */
export type InputRequests = Record<string, InputRequest>;

/** What the client came back with, under the same keys. */
export type InputResponses = Record<string, Record<string, unknown>>;

/** Thrown by a handler that has been asked for something it was not given.
 *
 * Not an error in any ordinary sense: it is the handler saying "ask the person
 * this, then run me again". The dispatcher turns it into the result the
 * specification describes, and the client's retry carries the answer. */
export class InputRequired extends Error {
  readonly requests: InputRequests;
  readonly state: string | undefined;

  constructor(requests: InputRequests, state?: string) {
    const names = Object.keys(requests).join(", ");
    super(`Input required before this can be answered: ${names}`);
    this.name = "InputRequired";
    this.requests = requests;
    if (state !== undefined) this.state = state;
  }
}

/** The result shape a request answers with when it needs more. */
export function inputRequiredResult(
  requests: InputRequests, state?: string,
): Record<string, unknown> {
  return {
    resultType: "input_required",
    inputRequests: requests,
    // Opaque to the client, which MUST NOT inspect it. Absent unless a handler
    // asked for one, because a server that recomputes has nothing to carry.
    ...(state !== undefined ? { requestState: state } : {}),
  };
}

/** Read the answers a client sent back with its retry. */
export function inputResponsesOf(params: Record<string, unknown>): InputResponses {
  const responses = params["inputResponses"];
  return responses && typeof responses === "object" && !Array.isArray(responses)
    ? responses as InputResponses
    : {};
}

export function requestStateOf(params: Record<string, unknown>): string | undefined {
  const state = params["requestState"];
  return typeof state === "string" ? state : undefined;
}
