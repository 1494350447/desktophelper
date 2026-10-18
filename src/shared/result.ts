export type ErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNAUTHORIZED"
  | "LOCKED"
  | "LIMIT"
  | "UNSUPPORTED"
  | "PROVIDER_ERROR"
  | "NETWORK"
  | "CANCELLED"
  | "INTERNAL";

export type IpcError = {
  code: ErrorCode;
  message: string;
  details?: unknown;
};

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError };

export function ok<T>(data: T): IpcResult<T> {
  return { ok: true, data };
}

export function err<T = never>(code: ErrorCode, message: string, details?: unknown): IpcResult<T> {
  return details === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, details } };
}

export function isOk<T>(result: IpcResult<T>): result is { ok: true; data: T } {
  return result.ok;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
  }
}

export function toIpcError(error: unknown): IpcError {
  if (error instanceof AppError) {
    return error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "INTERNAL", message };
}