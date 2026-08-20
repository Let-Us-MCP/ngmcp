/** JSON-RPC and MCP error codes, and the errors this runtime raises.
 *
 * `2026-07-28` retired `-32002` and forbids emitting it, so it is absent here
 * on purpose rather than by omission. A missing resource is `-32602`.
 */
export const CODE = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** The client asked for a protocol version this server does not implement. */
  unsupportedProtocolVersion: -32022,
  /** The request needs a client capability the client did not declare. */
  missingRequiredClientCapability: -32021,
} as const;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** An error whose message is safe to show a person. Anything else is internal. */
export class UserError extends RpcError {
  constructor(message: string, data?: unknown) {
    super(CODE.invalidParams, message, data);
    this.name = "UserError";
  }
}

export class UnsupportedProtocolVersionError extends RpcError {
  constructor(requested: unknown, supported: readonly string[]) {
    super(CODE.unsupportedProtocolVersion, "Unsupported protocol version", {
      supported: [...supported],
      requested,
    });
    this.name = "UnsupportedProtocolVersionError";
  }
}

export class MissingRequiredClientCapabilityError extends RpcError {
  constructor(requiredCapabilities: readonly string[]) {
    super(
      CODE.missingRequiredClientCapability,
      "Missing required client capability",
      { requiredCapabilities: [...requiredCapabilities] },
    );
    this.name = "MissingRequiredClientCapabilityError";
  }
}
