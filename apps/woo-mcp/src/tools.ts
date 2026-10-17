import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { WooClient, WooError } from './woo/client.ts';
import { InvalidDateError, normalizeDateBound } from './woo/dates.ts';
import { ORDER_STATUSES, PRODUCT_STATUSES } from './woo/types.ts';
import {
  orderDetail,
  orderNoteSummary,
  orderSummary,
  productDetail,
  productSummary,
  type PermalinkOptions,
} from './summaries.ts';

/**
 * The six WooCommerce tools (docs/contracts.md §12) registered on an McpServer.
 *
 * Conventions (contracts §3):
 *  - names are snake_case, every tool has title, description and annotations;
 *  - data results are `content: [{type:'text', text: <compact JSON>}]` plus the
 *    same object as `structuredContent`;
 *  - WooCommerce failures (4xx/5xx, timeouts, connection refused) and input
 *    problems we detect ourselves come back as `isError: true` with a readable
 *    message, never as JSON-RPC errors and never as a crashed request.
 */

export const TOOL_NAMES = [
  'list_products',
  'get_product',
  'create_product',
  'list_orders',
  'get_order',
  'update_order_status',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolDeps {
  woo: WooClient;
  storeName: string;
  /** Public storefront URL, used in descriptions and to rewrite permalinks. */
  storeUrl: string;
  /** Internal WordPress origin, used to recognise internal permalinks. */
  wooBaseUrl: string;
  logger?: Logger;
}

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const WRITE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const PRODUCT_STATUS_FILTER = ['any', ...PRODUCT_STATUSES] as const;
const ORDER_STATUS_FILTER = ['any', ...ORDER_STATUSES] as const;

/** Money as WooCommerce wants it: digits with an optional decimal part, e.g. "12" or "12.50". */
const MONEY = /^\d+(\.\d+)?$/;

function ok(data: object): CallToolResult {
  const structured: Record<string, unknown> = { ...data };
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
  };
}

function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

async function guarded(
  logger: Logger | undefined,
  tool: ToolName,
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof WooError) {
      logger?.warn({ tool, kind: err.kind, status: err.status, code: err.code }, 'tool failed: woocommerce error');
      return fail(err.message);
    }
    if (err instanceof InvalidDateError) {
      return fail(err.message);
    }
    const message = err instanceof Error ? err.message : String(err);
    logger?.error({ tool, err: message }, 'tool failed: unexpected error');
    return fail(`Unexpected error in ${tool}: ${message}`);
  }
}

/** Normalise `regular_price` (string or number) to a WooCommerce money string, or explain why it is invalid. */
export function normalizePrice(value: string | number): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      return { ok: false, reason: `regular_price must be a non-negative number, got ${String(value)}` };
    }
    return { ok: true, value: String(value) };
  }
  const trimmed = value.trim();
  if (!MONEY.test(trimmed)) {
    return {
      ok: false,
      reason: `regular_price must be a plain decimal amount such as "12.00" (no currency symbol), got "${value}"`,
    };
  }
  return { ok: true, value: trimmed };
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { woo, storeName, storeUrl, logger } = deps;
  const links: PermalinkOptions = { wooBaseUrl: deps.wooBaseUrl, storeUrl };
  const today = new Date().toISOString().slice(0, 10);

  // ---- list_products ------------------------------------------------------
  server.registerTool(
    'list_products',
    {
      title: 'List products',
      description:
        `List products in the "${storeName}" WooCommerce store (storefront: ${storeUrl}). ` +
        'Use it to find products by name/SKU (search), to see what is published or still a draft (status), ' +
        'or to page through the catalogue. Returns compact product summaries with id, name, sku, price, ' +
        'regular_price, status, stock_status, permalink and date_created, plus total, page and totalPages. ' +
        'Follow up with get_product for descriptions and stock quantities.',
      inputSchema: {
        search: z.string().trim().min(1).max(200).optional().describe('Free-text search over name, SKU and description.'),
        status: z
          .enum(PRODUCT_STATUS_FILTER)
          .optional()
          .describe("Filter by product status. Default 'any' (publish, draft, pending and private)."),
        per_page: z.int().min(1).max(100).optional().describe('Page size, 1-100. Default 20.'),
        page: z.int().min(1).optional().describe('1-based page number. Default 1.'),
      },
      annotations: { ...READ_ONLY, title: 'List products' },
    },
    async (args) =>
      guarded(logger, 'list_products', async () => {
        const page = args.page ?? 1;
        const result = await woo.listProducts({
          search: args.search,
          status: args.status ?? 'any',
          per_page: args.per_page ?? 20,
          page,
        });
        return ok({
          products: result.items.map((p) => productSummary(p, links)),
          total: result.total,
          page,
          totalPages: result.totalPages,
        });
      }),
  );

  // ---- get_product --------------------------------------------------------
  server.registerTool(
    'get_product',
    {
      title: 'Get product',
      description:
        `Fetch one product from "${storeName}" by its numeric WooCommerce id (from list_products). ` +
        'Returns the full product summary: id, name, sku, type, status, price, regular_price, sale_price, ' +
        'description, short_description, stock_status, manage_stock, stock_quantity, total_sales, categories, ' +
        'permalink, date_created and date_modified. Unknown ids return an error result.',
      inputSchema: {
        id: z.int().positive().describe('WooCommerce product id.'),
      },
      annotations: { ...READ_ONLY, title: 'Get product' },
    },
    async (args) =>
      guarded(logger, 'get_product', async () => {
        const product = await woo.getProduct(args.id);
        return ok(productDetail(product, links));
      }),
  );

  // ---- create_product -----------------------------------------------------
  server.registerTool(
    'create_product',
    {
      title: 'Create product',
      description:
        `Create a new simple product in "${storeName}". Requires a name and a regular_price (a plain decimal ` +
        'amount in the store currency, e.g. "19.99"). Optional description, short_description, sku, status ' +
        "(default 'publish'; use 'draft' to keep it hidden), and stock management (manage_stock + stock_quantity). " +
        'Returns the created product summary including its id and public permalink. Each call creates a new ' +
        'product; check list_products first if you are unsure whether it already exists.',
      inputSchema: {
        name: z.string().trim().min(1).max(200).describe('Product name as shown in the store.'),
        regular_price: z
          .union([z.string(), z.number()])
          .describe('Regular price, e.g. "12.00" or 12. Plain decimal, no currency symbol.'),
        description: z.string().max(20_000).optional().describe('Long description (HTML allowed).'),
        short_description: z.string().max(5_000).optional().describe('Short description shown near the price.'),
        sku: z.string().trim().max(100).optional().describe('Stock keeping unit; must be unique in the store.'),
        status: z
          .enum(PRODUCT_STATUSES)
          .optional()
          .describe("Product status. Default 'publish'. Use 'draft' for an unpublished product."),
        manage_stock: z.boolean().optional().describe('Track stock quantity for this product.'),
        stock_quantity: z
          .int()
          .min(0)
          .optional()
          .describe('Initial stock quantity (only meaningful with manage_stock: true).'),
      },
      annotations: { ...WRITE, title: 'Create product' },
    },
    async (args) =>
      guarded(logger, 'create_product', async () => {
        const price = normalizePrice(args.regular_price);
        if (!price.ok) return fail(price.reason);
        if (args.stock_quantity !== undefined && args.manage_stock === false) {
          return fail('stock_quantity was given but manage_stock is false; set manage_stock: true to track stock.');
        }
        const product = await woo.createProduct({
          name: args.name,
          regular_price: price.value,
          status: args.status ?? 'publish',
          description: args.description,
          short_description: args.short_description,
          sku: args.sku,
          manage_stock: args.stock_quantity !== undefined ? (args.manage_stock ?? true) : args.manage_stock,
          stock_quantity: args.stock_quantity,
        });
        logger?.info({ tool: 'create_product', productId: product.id }, 'product created');
        return ok(productDetail(product, links));
      }),
  );

  // ---- list_orders --------------------------------------------------------
  server.registerTool(
    'list_orders',
    {
      title: 'List orders',
      description:
        `List orders in "${storeName}", newest first. Filter by status (e.g. 'processing' for paid orders awaiting ` +
        'fulfilment), by date with after/before, or search by order number, customer name or email. ' +
        `Dates may be a calendar day in the store's timezone ("YYYY-MM-DD") or a full ISO 8601 date-time. ` +
        `Example: orders placed today -> {"after": "${today}"}; orders in a range -> {"after": "2026-10-01", "before": "2026-10-16"}. ` +
        'Returns order summaries (id, number, status, total, currency, date_created, customer_name, ' +
        'customer_email, payment_method_title, line_items[{name, quantity, total}]) plus total, page and totalPages. ' +
        'Use get_order for addresses and full line-item detail.',
      inputSchema: {
        status: z
          .enum(ORDER_STATUS_FILTER)
          .optional()
          .describe("Order status filter. Default 'any'."),
        after: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(`Only orders created on or after this day/date-time, e.g. "${today}" for today.`),
        before: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe('Only orders created on or before this day/date-time, e.g. "2026-10-16".'),
        search: z.string().trim().min(1).max(200).optional().describe('Search order number, customer name or email.'),
        per_page: z.int().min(1).max(100).optional().describe('Page size, 1-100. Default 20.'),
        page: z.int().min(1).optional().describe('1-based page number. Default 1.'),
      },
      annotations: { ...READ_ONLY, title: 'List orders' },
    },
    async (args) =>
      guarded(logger, 'list_orders', async () => {
        const after = args.after !== undefined ? normalizeDateBound(args.after, 'after') : undefined;
        const before = args.before !== undefined ? normalizeDateBound(args.before, 'before') : undefined;
        const page = args.page ?? 1;
        const result = await woo.listOrders({
          status: args.status ?? 'any',
          after,
          before,
          search: args.search,
          per_page: args.per_page ?? 20,
          page,
        });
        return ok({
          orders: result.items.map(orderSummary),
          total: result.total,
          page,
          totalPages: result.totalPages,
        });
      }),
  );

  // ---- get_order ----------------------------------------------------------
  server.registerTool(
    'get_order',
    {
      title: 'Get order',
      description:
        `Fetch one order from "${storeName}" by its numeric WooCommerce id (from list_orders). Returns the full ` +
        'order: id, number, status, currency, total, subtotal, shipping_total, total_tax, discount_total, ' +
        'payment_method, payment_method_title, date_created, date_paid, date_completed, customer_note, ' +
        'billing and shipping addresses (name, email, phone, address lines) and line_items ' +
        '[{id, name, sku, quantity, price, total}].',
      inputSchema: {
        id: z.int().positive().describe('WooCommerce order id (not the order number shown to customers).'),
      },
      annotations: { ...READ_ONLY, title: 'Get order' },
    },
    async (args) =>
      guarded(logger, 'get_order', async () => {
        const order = await woo.getOrder(args.id);
        return ok(orderDetail(order));
      }),
  );

  // ---- update_order_status ------------------------------------------------
  server.registerTool(
    'update_order_status',
    {
      title: 'Update order status',
      description:
        `Change the status of an order in "${storeName}" (e.g. mark a 'processing' order 'completed' once shipped, ` +
        "or 'cancelled'). Allowed statuses: " +
        ORDER_STATUSES.map((s) => `'${s}'`).join(', ') +
        '. An optional note is recorded on the order as a private (staff-only) note. Returns the updated order ' +
        'summary and the note that was added, if any. Look the order up with list_orders or get_order first.',
      inputSchema: {
        id: z.int().positive().describe('WooCommerce order id.'),
        status: z.enum(ORDER_STATUSES).describe('New order status.'),
        note: z
          .string()
          .trim()
          .min(1)
          .max(2_000)
          .optional()
          .describe('Optional private order note explaining the change.'),
      },
      annotations: { ...WRITE, title: 'Update order status' },
    },
    async (args) =>
      guarded(logger, 'update_order_status', async () => {
        // zod has already rejected anything outside ORDER_STATUSES; this is a belt-and-braces
        // check so a schema change can never let an unknown status reach WooCommerce.
        if (!(ORDER_STATUSES as readonly string[]).includes(args.status)) {
          return fail(`Invalid status "${String(args.status)}". Allowed: ${ORDER_STATUSES.join(', ')}.`);
        }
        const order = await woo.updateOrderStatus(args.id, args.status);
        const note = args.note !== undefined ? await woo.addOrderNote(args.id, args.note, false) : undefined;
        logger?.info({ tool: 'update_order_status', orderId: order.id, status: order.status }, 'order status updated');
        return ok({ ...orderSummary(order), note: note ? orderNoteSummary(note) : null });
      }),
  );
}
