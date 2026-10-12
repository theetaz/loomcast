import {
  ApiErrorSchema,
  buildPath,
  type PathParams,
  type RouteBody,
  type RouteDefinition,
  type RouteName,
  type RouteQuery,
  type RouteResponse,
  type Routes,
  routes,
} from "@loomcast/contracts";

/** `status` is 0 when the request never reached the server. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const NETWORK_ERROR = "network_error";
export const INVALID_RESPONSE = "invalid_response";

export function isApiError(error: unknown, status?: number): error is ApiError {
  return error instanceof ApiError && (status === undefined || error.status === status);
}

/** A sentence for the user. API messages are written for people, so they are shown as is. */
export function errorMessage(
  error: unknown,
  fallback = "Something went wrong. Try again.",
): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 0) return "Can't reach Loomcast. Check your connection and try again.";
  if (error.status === 429) return "Too many attempts. Wait a minute and try again.";
  if (error.status >= 500) return "Loomcast had a problem on its side. Try again in a moment.";
  return error.message || fallback;
}

type Params<N extends RouteName> = PathParams<Routes[N]["path"]>;

type RouteInput<N extends RouteName> = (keyof Params<N> extends never
  ? { params?: undefined }
  : { params: Params<N> }) &
  (RouteBody<N> extends undefined ? { body?: undefined } : { body: RouteBody<N> }) &
  (RouteQuery<N> extends undefined ? { query?: undefined } : { query?: RouteQuery<N> });

export type RequestOptions<N extends RouteName> = RouteInput<N> & {
  signal?: AbortSignal;
  /**
   * Session routes report a 401 to the unauthorized handler, which sends the
   * user to the login page. The auth guard turns this off and redirects itself.
   */
  redirectOnUnauthorized?: boolean;
};

type HasRequiredInput<N extends RouteName> = keyof Params<N> extends never
  ? RouteBody<N> extends undefined
    ? false
    : true
  : true;

/** Options are optional unless the route needs path parameters or a body. */
export type RequestArgs<N extends RouteName> =
  HasRequiredInput<N> extends true ? [options: RequestOptions<N>] : [options?: RequestOptions<N>];

interface LooseOptions {
  params?: Record<string, string>;
  body?: unknown;
  query?: Record<string, unknown>;
  signal?: AbortSignal;
  redirectOnUnauthorized?: boolean;
}

export type UnauthorizedHandler = (error: ApiError) => void;

export interface ApiClient {
  request<N extends RouteName>(name: N, ...args: RequestArgs<N>): Promise<RouteResponse<N>>;
  /** Replaces the handler called when a session route answers 401. Returns a remover. */
  setUnauthorizedHandler(handler: UnauthorizedHandler | null): () => void;
}

export interface ApiClientOptions {
  /** Resolved on every call, so test doubles installed later still apply. */
  fetch?: typeof fetch;
  /** Origin the `/api` paths are resolved against. Defaults to the page origin. */
  origin?: string;
}

async function readError(response: Response): Promise<ApiError> {
  const body: unknown = await response.json().catch(() => undefined);
  const parsed = ApiErrorSchema.safeParse(body);
  if (parsed.success) {
    const { code, message, details } = parsed.data.error;
    return new ApiError(response.status, code, message, details);
  }
  return new ApiError(response.status, "http_error", response.statusText || "Request failed");
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/**
 * A typed client for the REST routes in `@loomcast/contracts`. It sends the
 * session cookie and JSON headers the CSRF guard expects, validates success
 * bodies against the route's schema and turns failures into `ApiError`.
 */
export function createApiClient(clientOptions: ApiClientOptions = {}): ApiClient {
  let onUnauthorized: UnauthorizedHandler | null = null;

  function urlFor(route: RouteDefinition, input: LooseOptions): URL {
    const path = input.params ? buildPath(route.path, input.params) : route.path;
    const origin = clientOptions.origin ?? globalThis.location?.origin ?? "http://localhost";
    const url = new URL(path, origin);
    for (const [key, value] of Object.entries(input.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return url;
  }

  async function request<N extends RouteName>(
    name: N,
    ...[options]: RequestArgs<N>
  ): Promise<RouteResponse<N>> {
    const route: RouteDefinition = routes[name];
    const input = (options ?? {}) as LooseOptions;
    const doFetch = clientOptions.fetch ?? globalThis.fetch;

    let response: Response;
    try {
      response = await doFetch(urlFor(route, input), {
        method: route.method,
        credentials: "same-origin",
        // The CSRF guard requires the JSON content type on every unsafe method.
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: input.signal,
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new ApiError(0, NETWORK_ERROR, "Network request failed");
    }

    if (!response.ok) {
      const error = await readError(response);
      if (
        error.status === 401 &&
        route.auth === "session" &&
        input.redirectOnUnauthorized !== false
      ) {
        onUnauthorized?.(error);
      }
      throw error;
    }

    if (route.response === null || response.status === 204) {
      return undefined as RouteResponse<N>;
    }

    const body: unknown = await response.json().catch(() => undefined);
    const parsed = route.response.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(
        response.status,
        INVALID_RESPONSE,
        "The server sent a response this version of the app does not understand.",
        parsed.error.issues,
      );
    }
    return parsed.data as RouteResponse<N>;
  }

  return {
    request,
    setUnauthorizedHandler(handler) {
      onUnauthorized = handler;
      return () => {
        if (onUnauthorized === handler) onUnauthorized = null;
      };
    },
  };
}

/** The app-wide client. */
export const api = createApiClient();
