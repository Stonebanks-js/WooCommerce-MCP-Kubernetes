import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import express, { type NextFunction, type Request, type Response } from 'express';

/**
 * In-process fake of the WooCommerce REST API (wc/v3) subset woo-mcp uses.
 *
 * It mirrors the real API's shapes closely enough for the server under test
 * not to notice: Basic auth, X-WP-Total/X-WP-TotalPages headers, WP-style
 * error bodies ({code, message, data:{status}}), local-time `date_created`
 * strings without an offset, and `after`/`before` compared in local time.
 * Every request is recorded so tests can assert on what was (not) called.
 */

export interface FakeProduct {
  id: number;
  name: string;
  slug: string;
  permalink: string;
  type: string;
  status: string;
  sku: string;
  price: string;
  regular_price: string;
  sale_price: string;
  description: string;
  short_description: string;
  manage_stock: boolean;
  stock_quantity: number | null;
  stock_status: string;
  total_sales: number;
  categories: Array<{ id: number; name: string; slug: string }>;
  date_created: string;
  date_modified: string;
}

export interface FakeAddress {
  first_name: string;
  last_name: string;
  company: string;
  address_1: string;
  address_2: string;
  city: string;
  state: string;
  postcode: string;
  country: string;
  email: string;
  phone: string;
}

export interface FakeLineItem {
  id: number;
  name: string;
  product_id: number;
  quantity: number;
  sku: string;
  price: number;
  subtotal: string;
  total: string;
}

export interface FakeOrder {
  id: number;
  number: string;
  status: string;
  currency: string;
  total: string;
  total_tax: string;
  shipping_total: string;
  discount_total: string;
  payment_method: string;
  payment_method_title: string;
  customer_id: number;
  customer_note: string;
  date_created: string;
  date_modified: string;
  date_paid: string | null;
  date_completed: string | null;
  billing: FakeAddress;
  shipping: FakeAddress;
  line_items: FakeLineItem[];
}

export interface FakeNote {
  id: number;
  author: string;
  date_created: string;
  note: string;
  customer_note: boolean;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  authorized: boolean;
  body?: unknown;
}

export interface FakeWooOptions {
  username: string;
  appPassword: string;
  /** Origin used for permalinks (what WordPress would build from its `home` option). */
  permalinkOrigin?: string;
}

const ORDER_STATUSES = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed', 'trash'];

export function emptyAddress(overrides: Partial<FakeAddress> = {}): FakeAddress {
  return {
    first_name: '',
    last_name: '',
    company: '',
    address_1: '',
    address_2: '',
    city: '',
    state: '',
    postcode: '',
    country: '',
    email: '',
    phone: '',
    ...overrides,
  };
}

function localNow(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'product'
  );
}

function wpError(res: Response, status: number, code: string, message: string, extra?: Record<string, unknown>): void {
  res.status(status).json({ code, message, data: { status, ...extra } });
}

function paginate<T>(items: T[], query: Record<string, string>, res: Response): T[] {
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.per_page ?? '10', 10) || 10));
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  const total = items.length;
  const totalPages = Math.ceil(total / perPage);
  res.set('X-WP-Total', String(total));
  res.set('X-WP-TotalPages', String(totalPages));
  return items.slice((page - 1) * perPage, page * perPage);
}

export class FakeWoo {
  readonly products = new Map<number, FakeProduct>();
  readonly orders = new Map<number, FakeOrder>();
  readonly notes = new Map<number, FakeNote[]>();
  readonly requests: RecordedRequest[] = [];
  /** Artificial latency applied to every request (for timeout tests). */
  delayMs = 0;
  /** When set, every wc/v3 response is this status with a WP error body (for 5xx tests). */
  forceStatus: number | undefined;
  /** When set, every wc/v3 response is exactly this raw response (HTML error pages, non-JSON bodies). */
  forceResponse: { status: number; contentType: string; body: string } | undefined;

  private nextId = 100;
  private server: Server | undefined;
  private _url = '';
  private readonly opts: FakeWooOptions;

  constructor(opts: FakeWooOptions) {
    this.opts = opts;
  }

  /** Base URL (origin) once started. */
  get url(): string {
    return this._url;
  }

  get permalinkOrigin(): string {
    return this.opts.permalinkOrigin ?? this._url;
  }

  /** Requests to the wc/v3 API only (the readiness probe hits /wp-json/). */
  apiRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.path.startsWith('/wp-json/wc/v3'));
  }

  seedProduct(overrides: Partial<FakeProduct> & { name: string }): FakeProduct {
    const { name, ...rest } = overrides;
    const id = rest.id ?? this.nextId++;
    const slug = rest.slug ?? slugify(name);
    const now = localNow();
    const product: FakeProduct = {
      id,
      name,
      slug,
      permalink: `${this.permalinkOrigin}/product/${slug}/`,
      type: 'simple',
      status: 'publish',
      sku: '',
      price: '0',
      regular_price: '0',
      sale_price: '',
      description: '',
      short_description: '',
      manage_stock: false,
      stock_quantity: null,
      stock_status: 'instock',
      total_sales: 0,
      categories: [{ id: 15, name: 'Uncategorized', slug: 'uncategorized' }],
      date_created: now,
      date_modified: now,
      ...rest,
    };
    product.id = id;
    product.slug = slug;
    if (rest.price === undefined) product.price = product.regular_price;
    this.products.set(id, product);
    return product;
  }

  seedOrder(overrides: Partial<FakeOrder> = {}): FakeOrder {
    const id = overrides.id ?? this.nextId++;
    const now = localNow();
    const order: FakeOrder = {
      id,
      number: String(id),
      status: 'processing',
      currency: 'USD',
      total: '12.00',
      total_tax: '0.00',
      shipping_total: '0.00',
      discount_total: '0.00',
      payment_method: 'cod',
      payment_method_title: 'Cash on delivery',
      customer_id: 0,
      customer_note: '',
      date_created: now,
      date_modified: now,
      date_paid: null,
      date_completed: null,
      billing: emptyAddress(),
      shipping: emptyAddress(),
      line_items: [],
      ...overrides,
    };
    this.orders.set(id, order);
    return order;
  }

  async start(): Promise<string> {
    const app = express();
    app.disable('x-powered-by');
    app.use(express.json());

    app.use(async (req: Request, _res: Response, next: NextFunction) => {
      const query: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.query)) query[k] = String(v);
      this.requests.push({
        method: req.method,
        path: req.path,
        query,
        authorized: this.isAuthorized(req),
        body: req.method === 'GET' ? undefined : req.body,
      });
      if (this.delayMs > 0) await sleep(this.delayMs);
      next();
    });

    // WordPress REST index: unauthenticated, used by the readiness probe.
    app.get('/wp-json/', (_req, res) => {
      res.json({ name: 'Fake WordPress', url: this._url, namespaces: ['wp/v2', 'wc/v3'] });
    });

    const api = express.Router();
    api.use((req: Request, res: Response, next: NextFunction) => {
      if (!this.isAuthorized(req)) {
        wpError(res, 401, 'woocommerce_rest_cannot_view', 'Sorry, you cannot list resources.');
        return;
      }
      if (this.forceStatus !== undefined) {
        wpError(res, this.forceStatus, 'fake_forced_error', `Forced HTTP ${this.forceStatus}`);
        return;
      }
      if (this.forceResponse !== undefined) {
        res.status(this.forceResponse.status).type(this.forceResponse.contentType).send(this.forceResponse.body);
        return;
      }
      next();
    });

    // ---- products ---------------------------------------------------------
    api.get('/products', (req, res) => {
      const q = req.query as Record<string, string>;
      let items = [...this.products.values()];
      if (q.status && q.status !== 'any') items = items.filter((p) => p.status === q.status);
      if (q.search) {
        const s = q.search.toLowerCase();
        items = items.filter((p) => p.name.toLowerCase().includes(s) || p.sku.toLowerCase().includes(s));
      }
      items.sort((a, b) => (a.date_created < b.date_created ? 1 : a.date_created > b.date_created ? -1 : b.id - a.id));
      res.json(paginate(items, q, res));
    });

    api.get('/products/:id', (req, res) => {
      const product = this.products.get(Number(req.params.id));
      if (!product) {
        wpError(res, 404, 'woocommerce_rest_product_invalid_id', 'Invalid ID.');
        return;
      }
      res.json(product);
    });

    api.post('/products', (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.name !== 'string' || !body.name) {
        wpError(res, 400, 'rest_missing_callback_param', 'Missing parameter(s): name', { params: ['name'] });
        return;
      }
      if (body.regular_price !== undefined && typeof body.regular_price !== 'string') {
        wpError(res, 400, 'rest_invalid_param', 'Invalid parameter(s): regular_price', {
          params: { regular_price: 'regular_price is not of type string.' },
        });
        return;
      }
      const sku = typeof body.sku === 'string' ? body.sku : '';
      if (sku && [...this.products.values()].some((p) => p.sku === sku)) {
        wpError(res, 400, 'product_invalid_sku', 'Invalid or duplicated SKU.', { resource_id: 1 });
        return;
      }
      const manageStock = body.manage_stock === true;
      const product = this.seedProduct({
        name: body.name,
        type: typeof body.type === 'string' ? body.type : 'simple',
        status: typeof body.status === 'string' ? body.status : 'publish',
        regular_price: typeof body.regular_price === 'string' ? body.regular_price : '',
        description: typeof body.description === 'string' ? body.description : '',
        short_description: typeof body.short_description === 'string' ? body.short_description : '',
        sku,
        manage_stock: manageStock,
        stock_quantity: manageStock && typeof body.stock_quantity === 'number' ? body.stock_quantity : null,
        stock_status: manageStock && body.stock_quantity === 0 ? 'outofstock' : 'instock',
      });
      res.status(201).json(product);
    });

    // ---- orders -----------------------------------------------------------
    api.get('/orders', (req, res) => {
      const q = req.query as Record<string, string>;
      let items = [...this.orders.values()];
      if (q.status && q.status !== 'any') items = items.filter((o) => o.status === q.status);
      else items = items.filter((o) => o.status !== 'trash');
      if (q.after) {
        const t = Date.parse(q.after);
        items = items.filter((o) => Date.parse(o.date_created) >= t);
      }
      if (q.before) {
        const t = Date.parse(q.before);
        items = items.filter((o) => Date.parse(o.date_created) <= t);
      }
      if (q.search) {
        const s = q.search.toLowerCase();
        items = items.filter(
          (o) =>
            o.number.includes(s) ||
            `${o.billing.first_name} ${o.billing.last_name}`.toLowerCase().includes(s) ||
            o.billing.email.toLowerCase().includes(s),
        );
      }
      items.sort((a, b) => (a.date_created < b.date_created ? 1 : a.date_created > b.date_created ? -1 : b.id - a.id));
      res.json(paginate(items, q, res));
    });

    api.get('/orders/:id', (req, res) => {
      const order = this.orders.get(Number(req.params.id));
      if (!order) {
        wpError(res, 404, 'woocommerce_rest_shop_order_invalid_id', 'Invalid ID.');
        return;
      }
      res.json(order);
    });

    api.put('/orders/:id', (req, res) => {
      const order = this.orders.get(Number(req.params.id));
      if (!order) {
        wpError(res, 404, 'woocommerce_rest_shop_order_invalid_id', 'Invalid ID.');
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.status !== undefined) {
        if (typeof body.status !== 'string' || !ORDER_STATUSES.includes(body.status)) {
          wpError(res, 400, 'rest_invalid_param', 'Invalid parameter(s): status', {
            params: { status: `status is not one of ${ORDER_STATUSES.join(', ')}.` },
          });
          return;
        }
        order.status = body.status;
        order.date_modified = localNow();
        if ((body.status === 'processing' || body.status === 'completed') && !order.date_paid) {
          order.date_paid = order.date_modified;
        }
        if (body.status === 'completed') order.date_completed = order.date_modified;
      }
      res.json(order);
    });

    api.post('/orders/:id/notes', (req, res) => {
      const id = Number(req.params.id);
      if (!this.orders.has(id)) {
        wpError(res, 404, 'woocommerce_rest_shop_order_invalid_id', 'Invalid ID.');
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.note !== 'string' || !body.note) {
        wpError(res, 400, 'rest_missing_callback_param', 'Missing parameter(s): note', { params: ['note'] });
        return;
      }
      const note: FakeNote = {
        id: this.nextId++,
        author: 'system',
        date_created: localNow(),
        note: body.note,
        customer_note: body.customer_note === true,
      };
      const list = this.notes.get(id) ?? [];
      list.push(note);
      this.notes.set(id, list);
      res.status(201).json(note);
    });

    app.use('/wp-json/wc/v3', api);

    app.use((_req, res) => {
      wpError(res, 404, 'rest_no_route', 'No route was found matching the URL and request method.');
    });

    await new Promise<void>((resolve) => {
      this.server = app.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = this.server!.address() as AddressInfo;
    this._url = `http://127.0.0.1:${addr.port}`;
    return this._url;
  }

  /** Stop listening and drop keep-alive sockets so the next request fails at connect time. */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private isAuthorized(req: Request): boolean {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Basic ')) return false;
    const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    if (idx === -1) return false;
    const user = decoded.slice(0, idx);
    const pass = decoded.slice(idx + 1).replace(/\s+/g, '');
    return user === this.opts.username && pass === this.opts.appPassword.replace(/\s+/g, '');
  }
}
