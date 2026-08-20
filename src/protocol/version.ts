/** The one protocol version this runtime speaks.
 *
 * `2026-07-28` removed sessions and the `initialize` handshake. Every request
 * carries its own protocol version and client capabilities, so there is no
 * connection state to keep and no handshake to get wrong. That is the whole
 * reason this package exists, and it is why there is exactly one version here
 * rather than a list: supporting an older one means reintroducing the session
 * this version deleted, and the session is the thing worth being rid of.
 */
export const PROTOCOL_VERSION = "2026-07-28";

/** The MIME type the MCP Apps extension gives a view resource. */
export const APP_MIME = "text/html;profile=mcp-app";

/** The extension identifier for MCP Apps. */
export const UI_EXTENSION = "io.modelcontextprotocol/ui";

/** Reserved `_meta` keys this runtime reads or writes. */
export const META = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  clientInfo: "io.modelcontextprotocol/clientInfo",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
  logLevel: "io.modelcontextprotocol/logLevel",
  serverInfo: "io.modelcontextprotocol/serverInfo",
  progressToken: "progressToken",
} as const;
