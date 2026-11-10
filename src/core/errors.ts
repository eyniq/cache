/** An error that maps to an HTTP response. `body` is sent as JSON; never put secrets in it. */
export class HttpError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;

  constructor(
    status: number,
    message: string,
    body: Record<string, unknown> = { error: message },
    headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

export function isHttpError(err: unknown): err is HttpError {
  return err instanceof HttpError;
}

export const badRequest = (msg: string): HttpError => new HttpError(400, msg);
export const notFound = (msg = 'not found'): HttpError => new HttpError(404, msg);
export const badGateway = (msg: string): HttpError => new HttpError(502, msg);
export const gatewayTimeout = (msg: string): HttpError => new HttpError(504, msg);
/** Temporarily over a capacity limit: 503 with Retry-After, clients retry. */
export const overloaded = (msg: string, retryAfterSeconds = 1): HttpError =>
  new HttpError(503, msg, { error: msg }, { 'retry-after': String(retryAfterSeconds) });

/** The storage backend does not enforce conditional writes (If-None-Match / If-Match). */
export class ConditionalWritesUnsupported extends Error {
  constructor(message = 'storage backend does not support conditional writes') {
    super(message);
    this.name = 'ConditionalWritesUnsupported';
  }
}
