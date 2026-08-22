/** What a server is asked, and what counts as an answer.
 *
 * Each check encodes one requirement and reports one of four verdicts. Four
 * rather than two, for the same reason a host capability has three states: a
 * check that cannot distinguish "this server got it wrong" from "this server
 * was never asked" produces a matrix nobody can act on.
 *
 *     pass    asked, and answered correctly
 *     fail    asked, and answered wrongly. A requirement is broken.
 *     n/a     does not apply here — a legacy server has no `server/discover`,
 *             a server with no read-only tool cannot be asked to run one
 *     unknown asked, and the answer did not settle it. Never a quiet pass.
 *
 * One safety rule runs through all of it: **nothing destructive is called.**
 * Only a tool annotated `readOnlyHint: true` is ever invoked, and where none
 * exists the checks that need one report `n/a` rather than picking something
 * and hoping. A conformance run that restarts somebody's deployment to see
 * whether progress notifications are well formed has done more harm than the
 * defect it was looking for.
 */

export type Verdict = "pass" | "fail" | "n/a" | "unknown";

/** Which negotiation the server speaks, decided by asking rather than assuming.
 *
 * `bridged` is the one worth explaining. A server can answer `server/discover`
 * **and** `initialize`, because a shim in front of it answers the handshake and
 * fills in the `_meta` an older client does not send. That is a real and
 * sensible deployment — it is how anything reaches a shipping host today — but
 * it means the strict `_meta` requirements are no longer observable from
 * outside: the shim supplies them before the server ever sees the request.
 * Reporting such a server as `modern` and then failing it for accepting a
 * request with no `_meta` would be blaming it for the shim's whole purpose. */
export type Era = "modern" | "legacy" | "bridged" | "unreachable";

export interface CheckResult {
  verdict: Verdict;
  /** One line, in the terms of the requirement rather than of the code. */
  note: string;
}

export interface Context {
  era: Era;
  /** A request with the `_meta` this era expects, filled in. */
  ask(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  /** A request with `_meta` exactly as given, including not at all. */
  askRaw(message: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  raw(text: string): void;
  notifications(): Array<{ message: Record<string, unknown> }>;
  /** The tool list, fetched once. */
  tools(): Array<Record<string, unknown>>;
  /** The first tool annotated read-only, if the server has one. */
  safeTool(): Record<string, unknown> | undefined;
  nextId(): number;
  wait(ms: number): Promise<void>;
}

export interface Check {
  id: string;
  /** What is being asked, phrased so a failure reads as a sentence. */
  title: string;
  /** Which negotiations this applies to. */
  eras?: Era[];
  run(c: Context): Promise<CheckResult>;
}

const errorOf = (answer: Record<string, unknown> | null): Record<string, unknown> | null => {
  const error = answer?.["error"];
  return error && typeof error === "object" ? error as Record<string, unknown> : null;
};

const resultOf = (answer: Record<string, unknown> | null): Record<string, unknown> | null => {
  const result = answer?.["result"];
  return result && typeof result === "object" ? result as Record<string, unknown> : null;
};

const pass = (note: string): CheckResult => ({ verdict: "pass", note });
const fail = (note: string): CheckResult => ({ verdict: "fail", note });
const na = (note: string): CheckResult => ({ verdict: "n/a", note });
const unknown = (note: string): CheckResult => ({ verdict: "unknown", note });

export const CHECKS: Check[] = [
  {
    id: "discover.answers-any-version",
    title: "server/discover answers even on a version the server does not speak",
    eras: ["modern", "bridged"],
    async run(c) {
      const answer = await c.askRaw({
        jsonrpc: "2.0", id: c.nextId(), method: "server/discover",
        params: { _meta: {
          "io.modelcontextprotocol/protocolVersion": "1999-01-01",
          "io.modelcontextprotocol/clientCapabilities": {},
        } },
      });
      const result = resultOf(answer);
      if (!result) {
        return fail("refused a version it was asked about, so a client cannot "
          + "learn which versions exist");
      }
      const supported = result["supportedVersions"];
      return Array.isArray(supported) && supported.length
        ? pass(`offers ${supported.join(", ")}`)
        : fail("answered without naming a version it supports");
    },
  },

  {
    id: "version.refusal-is-32022",
    title: "another method on an unsupported version is -32022, naming what is supported",
    eras: ["modern", "bridged"],
    async run(c) {
      const answer = await c.askRaw({
        jsonrpc: "2.0", id: c.nextId(), method: "tools/list",
        params: { _meta: {
          "io.modelcontextprotocol/protocolVersion": "1999-01-01",
          "io.modelcontextprotocol/clientCapabilities": {},
        } },
      });
      const error = errorOf(answer);
      if (!error) return fail("accepted a version it does not speak");
      if (error["code"] !== -32022) {
        return fail(`refused with ${String(error["code"])} rather than -32022`);
      }
      const data = error["data"] as Record<string, unknown> | undefined;
      return Array.isArray(data?.["supported"])
        ? pass("refused with the supported list attached")
        : fail("refused with -32022 but no data.supported, so a client cannot recover");
    },
  },

  {
    id: "meta.required-fields",
    title: "a request missing protocolVersion or clientCapabilities is -32602",
    eras: ["modern"],
    async run(c) {
      const bare = await c.askRaw({
        jsonrpc: "2.0", id: c.nextId(), method: "tools/list", params: {},
      });
      const bareError = errorOf(bare);
      if (!bareError) {
        return fail("answered a request carrying no _meta, which means it is "
          + "reading context from somewhere other than the request");
      }
      if (bareError["code"] !== -32602) {
        return fail(`missing _meta gave ${String(bareError["code"])} rather than -32602`);
      }
      const half = await c.askRaw({
        jsonrpc: "2.0", id: c.nextId(), method: "tools/list",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
      });
      return errorOf(half)?.["code"] === -32602
        ? pass("both required fields are enforced")
        : fail("clientCapabilities is not required, only protocolVersion");
    },
  },

  {
    id: "initialize.answers",
    title: "initialize is answered, in a version the client offered",
    eras: ["legacy", "bridged"],
    async run(c) {
      const answer = await c.askRaw({
        jsonrpc: "2.0", id: c.nextId(), method: "initialize",
        params: {
          protocolVersion: "2025-06-18", capabilities: {},
          clientInfo: { name: "ngmcp-conform", version: "1.0.0" },
        },
      });
      const result = resultOf(answer);
      if (!result) return fail("did not answer initialize");
      const version = result["protocolVersion"];
      if (typeof version !== "string") return fail("answered without a protocolVersion");
      return version === "2025-06-18"
        ? pass("echoed the version offered")
        : unknown(`answered ${version}, which the client did not offer; a client `
          + "that hears a version it did not ask for usually stops there");
    },
  },

  {
    id: "tools.input-schema",
    title: "every tool publishes an inputSchema object, never null",
    async run(c) {
      const tools = c.tools();
      if (!tools.length) return na("this server registers no tools");
      const broken = tools.filter((tool) => {
        const schema = tool["inputSchema"];
        return schema === null || schema === undefined
          || typeof schema !== "object" || Array.isArray(schema);
      });
      return broken.length
        ? fail(`${broken.length} of ${tools.length} publish no schema object: `
          + broken.map((t) => String(t["name"])).join(", "))
        : pass(`${tools.length} tools, each with a schema object`);
    },
  },

  {
    id: "tools.names-unique",
    title: "no two tools share a name",
    async run(c) {
      const names = c.tools().map((t) => String(t["name"]));
      if (!names.length) return na("this server registers no tools");
      const seen = new Set<string>();
      const twice = names.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
      return twice.length
        ? fail(`${[...new Set(twice)].join(", ")} appears more than once, so a call is ambiguous`)
        : pass(`${names.length} distinct names`);
    },
  },

  {
    id: "resource.missing-is-not-32002",
    title: "a missing resource is an error, and never the retired -32002",
    async run(c) {
      const answer = await c.ask("resources/read",
        { uri: "ngmcp://conform/definitely-not-here" });
      const error = errorOf(answer);
      if (!error) {
        const result = resultOf(answer);
        const contents = result?.["contents"];
        return Array.isArray(contents) && contents.length === 0
          ? fail("answered a missing resource with an empty contents array, which "
            + "this version forbids; a client cannot tell that from an empty file")
          : fail("answered a resource it does not have");
      }
      return error["code"] === -32002
        ? fail("-32002 was retired and this version forbids emitting it")
        : pass(`refused with ${String(error["code"])}`);
    },
  },

  {
    id: "method.unknown-is-32601",
    title: "an unknown method is -32601",
    async run(c) {
      const answer = await c.ask("ngmcp/definitely-not-a-method");
      const error = errorOf(answer);
      if (!error) return fail("answered a method it does not implement");
      return error["code"] === -32601
        ? pass("refused with -32601")
        : unknown(`refused with ${String(error["code"])} rather than -32601`);
    },
  },

  {
    id: "json.malformed-is-32700",
    title: "a body that is not JSON is a parse error, not a crash",
    async run(c) {
      c.raw("{ this is not json\n");
      await c.wait(300);
      const parse = c.notifications().find((n) => {
        const error = n.message["error"] as Record<string, unknown> | undefined;
        return error?.["code"] === -32700;
      });
      if (parse) return pass("answered -32700");
      // Over HTTP the answer comes back on the same call rather than as
      // unsolicited traffic, so silence here is not the same as a failure.
      const alive = await c.ask("tools/list");
      return alive
        ? unknown("no -32700 was seen, but the server is still answering")
        : fail("stopped answering after a malformed body");
    },
  },

  {
    id: "notification.gets-no-answer",
    title: "a notification is not answered",
    async run(c) {
      const before = c.notifications().length;
      c.raw(`${JSON.stringify({
        jsonrpc: "2.0", method: "notifications/cancelled",
        params: { requestId: 999999 },
      })}\n`);
      await c.wait(300);
      const answered = c.notifications().slice(before).some((n) =>
        "result" in n.message || "error" in n.message);
      if (answered) return fail("answered a message that carried no id");
      const alive = await c.ask("tools/list");
      return alive
        ? pass("ignored it, and kept answering")
        : fail("stopped answering after a cancellation for an unknown request");
    },
  },

  {
    id: "progress.needs-a-token",
    title: "no progressToken, no progress notifications",
    async run(c) {
      const tool = c.safeTool();
      if (!tool) {
        return na("no tool is annotated readOnlyHint, and nothing destructive is called");
      }
      const before = c.notifications().length;
      await c.ask("tools/call", { name: String(tool["name"]), arguments: {} });
      await c.wait(200);
      const progress = c.notifications().slice(before).filter((n) =>
        n.message["method"] === "notifications/progress");
      return progress.length
        ? fail(`${progress.length} progress notifications for a request that asked `
          + "for none, inventing a correlation the client cannot use")
        : pass("silent, as a request with no token should be");
    },
  },

  {
    id: "notify.nothing-after-the-response",
    title: "nothing arrives for a request after that request is answered",
    async run(c) {
      const tool = c.safeTool();
      if (!tool) {
        return na("no tool is annotated readOnlyHint, and nothing destructive is called");
      }
      const id = c.nextId();
      await c.askRaw({
        jsonrpc: "2.0", id, method: "tools/call",
        params: {
          name: String(tool["name"]), arguments: {}, progressToken: `conform-${id}`,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
            progressToken: `conform-${id}`,
          },
        },
      });
      const after = c.notifications().length;
      await c.wait(400);
      // Any request-scoped traffic, not only traffic carrying this token. A
      // server sending progress under a token nobody supplied is doing two
      // wrong things, and narrowing to a matching token misses both.
      const late = c.notifications().slice(after).filter((n) => {
        const method = String(n.message["method"] ?? "");
        return method === "notifications/progress" || method === "notifications/message";
      });
      if (!late.length) return pass("nothing followed the response");
      const tokens = [...new Set(late.map((n) => {
        const params = n.message["params"] as Record<string, unknown> | undefined;
        return String(params?.["progressToken"] ?? "none");
      }))];
      return fail(`${late.length} messages arrived after the response `
        + `(token ${tokens.join(", ")}), for a request the client has finished with`);
    },
  },

  {
    id: "mrtr.no-server-requests",
    title: "the server never sends a request of its own",
    async run(c) {
      const tool = c.safeTool();
      if (!tool) {
        return na("no tool is annotated readOnlyHint, and nothing destructive is called");
      }
      const before = c.notifications().length;
      await c.ask("tools/call", { name: String(tool["name"]), arguments: {} });
      await c.wait(300);
      // A message carrying both a method and an id is a request. From a server
      // that is the pattern this version removed: input is asked for inside a
      // result, so the client can retry anywhere rather than answering the one
      // process that asked.
      const requests = c.notifications().slice(before).filter((n) =>
        typeof n.message["method"] === "string"
        && n.message["id"] !== undefined && n.message["id"] !== null);
      if (!requests.length) return pass("nothing was sent that expects an answer");
      const methods = [...new Set(requests.map((n) => String(n.message["method"])))];
      return fail(`sent ${methods.join(", ")} as a request of its own; this version `
        + "replaced that with an input_required result the client retries");
    },
  },

  {
    id: "ui.view-resolves",
    title: "a tool naming a view has that view readable, with the app mime type",
    async run(c) {
      const withView = c.tools()
        .map((tool) => {
          const meta = tool["_meta"] as Record<string, unknown> | undefined;
          const ui = meta?.["ui"] as Record<string, unknown> | undefined;
          return { name: String(tool["name"]), uri: ui?.["resourceUri"] };
        })
        .filter((t): t is { name: string; uri: string } => typeof t.uri === "string");

      if (!withView.length) return na("no tool names a view");

      for (const tool of withView) {
        const answer = await c.ask("resources/read", { uri: tool.uri });
        const contents = resultOf(answer)?.["contents"];
        if (!Array.isArray(contents) || !contents.length) {
          return fail(`${tool.name} names ${tool.uri}, which the server will not read`);
        }
        const first = contents[0] as Record<string, unknown>;
        const mime = String(first["mimeType"] ?? "");
        if (!mime.startsWith("text/html")) {
          return fail(`${tool.uri} came back as ${mime || "no mime type"}`);
        }
        if (!mime.includes("profile=mcp-app")) {
          return unknown(`${tool.uri} is ${mime}, without the mcp-app profile, so a `
            + "host may not treat it as an app");
        }
      }
      return pass(`${withView.length} view${withView.length > 1 ? "s" : ""} resolve`);
    },
  },
];
