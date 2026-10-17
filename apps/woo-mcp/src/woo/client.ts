import type { Logger } from 'pino';
import type { WooErrorBody, WooOrder, WooOrderNote, WooProduct } from './types.ts';

/**
 * Minimal WooCommerce REST (wc/v3) client.
 *
 * Authentication is HTTP Basic with a WordPress *application password*.
 * WooCommerce accepts Basic auth on every REST route; this avoids generating
 * WooCommerce consumer keys at install time: the setup job just installs a
 * known application password for the `mcp-bot` (shop_manager) user and this
 * server reads the same value from the same Secret.
 */

export type WooErrorKind = 'http' | 'timeout' | 'network' | 'invalid_response';

export class WooError extends Error {
  override name = 'WooError';
  /** HTTP status for `http` errors, 0 otherwise. */
  readonly status: number;
  /** WooCommerce / WP error code (e.g. `woocommerce_rest_shop_order_invalid_id`) or a client-side kind. */
  readonly code: string;
  readonly kind: WooErrorKind;
  readonly method: string;
  readonly path: string;

  constructor(
    kind: WooErrorKind,
    message: string,
    opts: { status?: number; code?: string; method: string; path: string },
  ) {
    super(message);
    this.kind = kind;
    this.status = opts.status ?? 0;
    this.code = opts.code ?? kind;
    this.method = opts.method;
    this.path = opts.path;
  }
}

export type QueryValue = string | number | boolean | undefined;
export type Query = Record<string, QueryValue>;

export interface WooResponse<T> {
  data: T;
  headers: Headers;
}

export interface Page<T> {
  items: T[];
  total: number;
  totalPages: number;
}

export interface ListProductsParams {
  search?: string;
  status?: string;
  per_page?: number;
  page?: number;
}

export interface CreateProductInput {
  name: string;
  regular_price: string;
  status: string;
  description?: string;
  short_description?: string;
  sku?: string;
  manage_stock?: boolean;
  stock_quantity?: number;
}

export interface ListOrdersParams {
  status?: string;
  after?: string;
  before?: string;
  search?: string;
  per_page?: number;
  page?: number;
}

export type FetchLike = typeof fetch;

export interface WooClientOptions {
  /** WordPress origin, no trailing slash. */
  baseUrl: string;
  username: string;
  appPassword: string;
  timeoutMs: number;
  logger?: Logger;
  /** Injectable for tests. */
  fetch?: FetchLike;
}

const API_PREFIX = '/wp-json/wc/v3';

export class WooClient {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  private readonly authHeader: string;
  private readonly logger: Logger | undefined;
  private readonly fetchImpl: FetchLike;

  constructor(opts: WooClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs;
    this.authHeader = `Basic ${Buffer.from(`${opts.username}:${opts.appPassword}`, 'utf8').toString('base64')}`;
    this.logger = opts.logger;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  // ---- generic HTTP -------------------------------------------------------

  async get<T>(path: string, query?: Query): Promise<WooResponse<T>> {
    return this.request<T>('GET', path, { query });
  }

  async post<T>(path: string, body: unknown): Promise<WooResponse<T>> {
    return this.request<T>('POST', path, { body });
  }

  async put<T>(path: string, body: unknown): Promise<WooResponse<T>> {
    return this.request<T>('PUT', path, { body });
  }

  /**
   * One REST call. Resolves with the parsed JSON body for 2xx, rejects with a
   * WooError for everything else (HTTP errors, timeouts, connection failures,
   * non-JSON bodies). Never throws anything that is not a WooError.
   */
  async request<T>(
    method: string,
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<WooResponse<T>> {
    const url = new URL(`${this.baseUrl}${API_PREFIX}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      Authorization: this.authHeader,
      Accept: 'application/json',
      'User-Agent': 'urumi-woo-mcp',
    };
    const init: RequestInit = {
      method,
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }
    const started = Date.now();
    const where = `${method} ${API_PREFIX}${path}`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (err) {
      const e = this.mapFetchError(err, method, path, where);
      this.logger?.warn(
        { method, path, durationMs: Date.now() - started, kind: e.kind, err: e.message },
        'woo request failed',
      );
      throw e;
    }

    const text = await res.text();
    let json: unknown = undefined;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    this.logger?.debug({ method, path, status: res.status, durationMs: Date.now() - started }, 'woo request');

    if (!res.ok) {
      throw this.mapHttpError(res.status, json, text, method, path);
    }
    if (json === undefined && text.length > 0) {
      throw new WooError(
        'invalid_response',
        `WooCommerce returned a non-JSON body for ${where} (HTTP ${res.status})`,
        { status: res.status, method, path },
      );
    }
    return { data: json as T, headers: res.headers };
  }

  private mapFetchError(err: unknown, method: string, path: string, where: string): WooError {
    const e = err as {
      name?: string;
      code?: string;
      message?: string;
      cause?: { code?: string; message?: string };
    };
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return new WooError('timeout', `WooCommerce request timed out after ${this.timeoutMs} ms (${where})`, {
        code: 'timeout',
        method,
        path,
      });
    }
    const cause = e?.cause;
    let detail = cause?.message ?? e?.message ?? 'unknown error';
    if (cause?.code && !detail.includes(cause.code)) detail = `${cause.code}: ${detail}`;
    return new WooError('network', `WooCommerce is unreachable (${where}): ${detail}`, {
      code: cause?.code ?? 'unreachable',
      method,
      path,
    });
  }

  private mapHttpError(status: number, json: unknown, text: string, method: string, path: string): WooError {
    const body = (json && typeof json === 'object' ? json : {}) as WooErrorBody;
    const code = typeof body.code === 'string' && body.code ? body.code : `http_${status}`;
    let message = typeof body.message === 'string' && body.message ? plainText(body.message) : '';
    if (!message) {
      // Not a WP error body: a WordPress fatal-error page, a proxy error page, or nothing at all.
      const snippet = plainText(text).slice(0, 160);
      message = snippet ? snippet : 'no response body';
    }
    const params = body.data?.params;
    if (params && typeof params === 'object') {
      const details = Object.values(params)
        .filter((v) => typeof v === 'string')
        .join('; ');
      if (details) message = `${message} ${details}`;
    }
    return new WooError('http', `WooCommerce returned ${status} (${code}): ${message}`, {
      status,
      code,
      method,
      path,
    });
  }

  // ---- readiness -----------------------------------------------------------

  /**
   * True when `${baseUrl}/wp-json/` answers with 2xx/3xx. Used by /readyz.
   * Unauthenticated on purpose: it only proves WordPress is up and routing
   * REST requests.
   */
  async ping(signal?: AbortSignal): Promise<{ ok: boolean; status?: number; error?: string }> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/wp-json/`, {
        method: 'GET',
        headers: { Accept: 'application/json', 'User-Agent': 'urumi-woo-mcp' },
        redirect: 'manual',
        signal: signal ?? AbortSignal.timeout(this.timeoutMs),
      });
      // Drain the body so the socket can be reused.
      await res.arrayBuffer().catch(() => undefined);
      const ok = res.status >= 200 && res.status < 400;
      return ok ? { ok, status: res.status } : { ok, status: res.status, error: `HTTP ${res.status}` };
    } catch (err) {
      const e = this.mapFetchError(err, 'GET', '/wp-json/', 'GET /wp-json/');
      return { ok: false, error: e.message };
    }
  }

  // ---- products ------------------------------------------------------------

  async listProducts(params: ListProductsParams): Promise<Page<WooProduct>> {
    const res = await this.get<WooProduct[]>('/products', {
      search: params.search,
      status: params.status ?? 'any',
      per_page: params.per_page ?? 20,
      page: params.page ?? 1,
    });
    return pageOf(res, 'GET', '/products');
  }

  async getProduct(id: number): Promise<WooProduct> {
    return objectOf(await this.get<WooProduct>(`/products/${id}`), 'GET', `/products/${id}`);
  }

  async createProduct(input: CreateProductInput): Promise<WooProduct> {
    const body: Record<string, unknown> = {
      name: input.name,
      type: 'simple',
      regular_price: String(input.regular_price),
      status: input.status,
    };
    if (input.description !== undefined) body.description = input.description;
    if (input.short_description !== undefined) body.short_description = input.short_description;
    if (input.sku !== undefined) body.sku = input.sku;
    if (input.manage_stock !== undefined) body.manage_stock = input.manage_stock;
    if (input.stock_quantity !== undefined) body.stock_quantity = input.stock_quantity;
    return objectOf(await this.post<WooProduct>('/products', body), 'POST', '/products');
  }

  // ---- orders --------------------------------------------------------------

  async listOrders(params: ListOrdersParams): Promise<Page<WooOrder>> {
    const res = await this.get<WooOrder[]>('/orders', {
      status: params.status ?? 'any',
      after: params.after,
      before: params.before,
      search: params.search,
      per_page: params.per_page ?? 20,
      page: params.page ?? 1,
    });
    return pageOf(res, 'GET', '/orders');
  }

  async getOrder(id: number): Promise<WooOrder> {
    return objectOf(await this.get<WooOrder>(`/orders/${id}`), 'GET', `/orders/${id}`);
  }

  async updateOrderStatus(id: number, status: string): Promise<WooOrder> {
    return objectOf(await this.put<WooOrder>(`/orders/${id}`, { status }), 'PUT', `/orders/${id}`);
  }

  async addOrderNote(id: number, note: string, customerNote = false): Promise<WooOrderNote> {
    return objectOf(
      await this.post<WooOrderNote>(`/orders/${id}/notes`, { note, customer_note: customerNote }),
      'POST',
      `/orders/${id}/notes`,
    );
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsaquo: '\u203a',
  lsaquo: '\u2039',
  raquo: '\u00bb',
  laquo: '\u00ab',
  hellip: '\u2026',
  ndash: '\u2013',
  mdash: '\u2014',
};

/**
 * WordPress error messages and fatal-error pages are HTML. Reduce them to one
 * line of plain text so the model (and a human reading logs) gets
 * "There has been a critical error on this website." instead of markup.
 */
export function plainText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, ent: string) => {
      if (ent[0] === '#') {
        const cp = ent[1]?.toLowerCase() === 'x' ? Number.parseInt(ent.slice(2), 16) : Number.parseInt(ent.slice(1), 10);
        return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
      }
      return ENTITIES[ent.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** A 2xx response whose body is not the JSON object we asked for (e.g. `null`, an array, a login page). */
function objectOf<T>(res: WooResponse<T>, method: string, path: string): T {
  const d: unknown = res.data;
  if (d === null || typeof d !== 'object' || Array.isArray(d)) {
    throw new WooError(
      'invalid_response',
      `WooCommerce returned an unexpected body for ${method} ${API_PREFIX}${path} (expected a JSON object)`,
      { status: 200, method, path },
    );
  }
  return res.data;
}

/** A 2xx list response whose body is not a JSON array: do not pretend the store is empty. */
function pageOf<T>(res: WooResponse<T[]>, method: string, path: string): Page<T> {
  if (!Array.isArray(res.data)) {
    throw new WooError(
      'invalid_response',
      `WooCommerce returned an unexpected body for ${method} ${API_PREFIX}${path} (expected a JSON array)`,
      { status: 200, method, path },
    );
  }
  const items = res.data;
  const total = parseIntHeader(res.headers.get('x-wp-total'), items.length);
  const totalPages = parseIntHeader(res.headers.get('x-wp-totalpages'), items.length > 0 ? 1 : 0);
  return { items, total, totalPages };
}

function parseIntHeader(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
