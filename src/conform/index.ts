/** Run the checks against a server, and say what happened.
 *
 * Works against any MCP server, not only one built here. That is the point:
 * a conformance harness that only agrees with its own implementation is a
 * second copy of the test suite, and it will agree with every mistake the
 * implementation makes.
 */
import { CHECKS, type Check, type CheckResult, type Context, type Era } from "./checks.js";
import { stdioProbe, httpProbe, type Probe } from "./probe.js";
import { PROTOCOL_VERSION, META } from "../protocol/version.js";

export interface ConformOptions {
  /** Spawn this and talk over its pipes. */
  command?: { command: string; args: readonly string[] };
  /** Or post to this URL. */
  url?: string;
  /** Milliseconds any single request may take. */
  timeoutMs?: number;
  /** Run only these check ids. */
  only?: readonly string[];
}

export interface Finding extends CheckResult {
  id: string;
  title: string;
}

export interface Report {
  era: Era;
  /** What the server called itself, where it said. */
  server: string;
  findings: Finding[];
  passed: number;
  failed: number;
  notApplicable: number;
  unknown: number;
  /** Anything the server wrote to stderr, which is often where the reason is. */
  stderr: string;
}

const detectEra = async (
  probe: Probe, nextId: () => number, timeoutMs: number,
): Promise<{ era: Era; server: string }> => {
  // Asked rather than assumed, and in this order because a modern server is
  // the one this tool is chiefly for. A legacy server answers the second.
  const modern = await probe.request({
    jsonrpc: "2.0", id: nextId(), method: "server/discover",
    params: { _meta: {
      [META.protocolVersion]: PROTOCOL_VERSION,
      [META.clientCapabilities]: {},
      [META.clientInfo]: { name: "ngmcp-conform", version: "1.0.0" },
    } },
  }, timeoutMs);
  const legacy = await probe.request({
    jsonrpc: "2.0", id: nextId(), method: "initialize",
    params: {
      protocolVersion: "2025-06-18", capabilities: {},
      clientInfo: { name: "ngmcp-conform", version: "1.0.0" },
    },
  }, timeoutMs);
  const modernResult = modern?.["result"] as Record<string, unknown> | undefined;
  const legacyRaw = legacy?.["result"] as Record<string, unknown> | undefined;
  // An `initialize` that comes back without a protocolVersion is not a
  // handshake, it is a server answering everything. Treating that as legacy
  // would excuse it from the checks a modern server has to pass.
  const legacyResult = typeof legacyRaw?.["protocolVersion"] === "string"
    ? legacyRaw : undefined;

  const modernName = () => {
    const meta = modernResult?.["_meta"] as Record<string, unknown> | undefined;
    const info = meta?.[META.serverInfo] as Record<string, unknown> | undefined;
    return String(info?.["name"] ?? "unnamed");
  };
  const legacyName = () => {
    const info = legacyResult?.["serverInfo"] as Record<string, unknown> | undefined;
    return String(info?.["name"] ?? "unnamed");
  };

  // Both are asked before either is concluded from. A server that answers both
  // has a shim in front of it, and calling that `modern` would mean failing it
  // for the shim's entire purpose.
  if (modernResult && legacyResult) return { era: "bridged", server: modernName() };
  if (modernResult) return { era: "modern", server: modernName() };
  if (legacyResult) return { era: "legacy", server: legacyName() };
  return { era: "unreachable", server: "" };
};

export async function conform(options: ConformOptions): Promise<Report> {
  const probe = options.command
    ? stdioProbe(options.command.command, options.command.args)
    : httpProbe(options.url ?? "");
  const timeoutMs = options.timeoutMs ?? 5000;

  let counter = 0;
  const nextId = () => (counter += 1);

  try {
    const { era, server } = await detectEra(probe, nextId, timeoutMs);
    if (era === "unreachable") {
      return {
        era, server: "",
        findings: [{
          id: "connect",
          title: "the server answers at all",
          verdict: "fail",
          // Both were tried, and saying which is more useful than saying neither.
          note: "answered neither server/discover nor initialize",
        }],
        passed: 0, failed: 1, notApplicable: 0, unknown: 0,
        stderr: probe.stderr(),
      };
    }

    const metaFor = () => (era === "modern" || era === "bridged"
      ? { _meta: {
          [META.protocolVersion]: PROTOCOL_VERSION,
          [META.clientCapabilities]: {},
          [META.clientInfo]: { name: "ngmcp-conform", version: "1.0.0" },
        } }
      : {});

    const ask = (method: string, params: Record<string, unknown> = {}) =>
      probe.request({
        jsonrpc: "2.0", id: nextId(), method,
        params: { ...params, ...metaFor() },
      }, timeoutMs);

    const listed = await ask("tools/list");
    const listedResult = listed?.["result"] as Record<string, unknown> | undefined;
    const tools = Array.isArray(listedResult?.["tools"])
      ? listedResult["tools"] as Array<Record<string, unknown>> : [];

    // Only a tool that says it changes nothing is ever called. A conformance
    // run that restarts somebody's deployment to check the shape of a progress
    // notification has done more harm than the defect it went looking for.
    const safe = tools.find((tool) => {
      const annotations = tool["annotations"] as Record<string, unknown> | undefined;
      const schema = tool["inputSchema"] as Record<string, unknown> | undefined;
      const required = schema?.["required"];
      // And only one that needs no arguments, since inventing them is guessing.
      return annotations?.["readOnlyHint"] === true
        && (!Array.isArray(required) || required.length === 0);
    });

    const context: Context = {
      era, ask,
      askRaw: (message) => probe.request(message, timeoutMs),
      raw: (text) => probe.raw(text),
      notifications: () => probe.notifications(),
      tools: () => tools,
      safeTool: () => safe,
      nextId,
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    };

    const findings: Finding[] = [];
    for (const check of CHECKS as Check[]) {
      if (options.only?.length && !options.only.includes(check.id)) continue;
      if (check.eras && !check.eras.includes(era)) {
        findings.push({
          id: check.id, title: check.title, verdict: "n/a",
          note: `only applies to a ${check.eras.join(" or ")} server`,
        });
        continue;
      }
      try {
        findings.push({ id: check.id, title: check.title, ...(await check.run(context)) });
      } catch (cause) {
        // A check that throws is a defect in the harness, and saying so is
        // better than reporting it as a failure of the server.
        findings.push({
          id: check.id, title: check.title, verdict: "unknown",
          note: `the check itself failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
      }
    }

    const count = (v: string) => findings.filter((f) => f.verdict === v).length;
    return {
      era, server, findings,
      passed: count("pass"),
      failed: count("fail"),
      notApplicable: count("n/a"),
      unknown: count("unknown"),
      stderr: probe.stderr(),
    };
  } finally {
    await probe.close();
  }
}

export { CHECKS } from "./checks.js";
export type { Check, CheckResult, Verdict, Era } from "./checks.js";
export { stdioProbe, httpProbe } from "./probe.js";
export type { Probe } from "./probe.js";
