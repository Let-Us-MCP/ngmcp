export type Id = string | number;

export interface Request {
  jsonrpc: "2.0";
  id: Id;
  method: string;
  params?: Record<string, unknown>;
}

export interface Notification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface Success {
  jsonrpc: "2.0";
  id: Id;
  result: Record<string, unknown>;
}

export interface Failure {
  jsonrpc: "2.0";
  id: Id | null;
  error: { code: number; message: string; data?: unknown };
}

export type Response = Success | Failure;
export type Incoming = Request | Notification;

export const isRequest = (m: unknown): m is Request =>
  typeof m === "object" && m !== null && "method" in m && "id" in m &&
  (m as Request).id !== null && (m as Request).id !== undefined;

export const isNotification = (m: unknown): m is Notification =>
  typeof m === "object" && m !== null && "method" in m &&
  !("id" in m && (m as Request).id !== null && (m as Request).id !== undefined);
