export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, "bad_request", message, details);
export const unauthorized = (message = "Authentication required") => new AppError(401, "unauthorized", message);
export const forbidden = (message = "You do not have permission to do this") => new AppError(403, "forbidden", message);
export const notFound = (what = "Resource") => new AppError(404, "not_found", `${what} not found`);
export const conflict = (message: string) => new AppError(409, "conflict", message);
export const quotaExceeded = (message: string, details?: unknown) => new AppError(402, "quota_exceeded", message, details);
export const tooMany = (message = "Too many requests, please slow down") => new AppError(429, "rate_limited", message);
export const unavailable = (message: string) => new AppError(503, "unavailable", message);
