import type { WooAddress, WooLineItem, WooOrder, WooOrderNote, WooProduct } from './woo/types.ts';

/**
 * Compact, model-friendly views of WooCommerce objects. These are exactly the
 * shapes documented in docs/contracts.md §12; every tool returns one of them as
 * both `structuredContent` and the JSON text block.
 */

export interface ProductSummary {
  id: number;
  name: string;
  sku: string;
  price: string;
  regular_price: string;
  status: string;
  stock_status: string;
  permalink: string;
  date_created: string;
}

export interface ProductDetail extends ProductSummary {
  type: string;
  sale_price: string;
  description: string;
  short_description: string;
  manage_stock: boolean;
  stock_quantity: number | null;
  total_sales: number;
  categories: Array<{ id: number; name: string }>;
  date_modified: string | null;
}

export interface LineItemSummary {
  name: string;
  quantity: number;
  total: string;
}

export interface OrderSummary {
  id: number;
  number: string;
  status: string;
  total: string;
  currency: string;
  date_created: string;
  customer_name: string;
  customer_email: string;
  payment_method_title: string;
  line_items: LineItemSummary[];
}

export interface AddressSummary {
  name: string;
  company: string;
  email: string;
  phone: string;
  address_1: string;
  address_2: string;
  city: string;
  state: string;
  postcode: string;
  country: string;
}

export interface LineItemDetail {
  id: number;
  name: string;
  sku: string;
  quantity: number;
  price: string;
  total: string;
}

export interface OrderDetail {
  id: number;
  number: string;
  status: string;
  currency: string;
  total: string;
  subtotal: string;
  shipping_total: string;
  total_tax: string;
  discount_total: string;
  payment_method: string;
  payment_method_title: string;
  date_created: string;
  date_paid: string | null;
  date_completed: string | null;
  customer_id: number;
  customer_note: string;
  billing: AddressSummary;
  shipping: AddressSummary;
  line_items: LineItemDetail[];
}

export interface OrderNoteSummary {
  id: number;
  note: string;
  date_created: string;
  customer_note: boolean;
}

export interface PermalinkOptions {
  /** Internal WordPress origin (WOO_BASE_URL). */
  wooBaseUrl: string;
  /** Public storefront origin (STORE_URL). */
  storeUrl: string;
}

/**
 * WordPress builds permalinks from its `home` option. Inside the cluster that
 * may be the internal service URL, which is useless to a human. When a
 * permalink starts with the internal origin we swap in the public one.
 */
export function publicPermalink(permalink: string | undefined, opts: PermalinkOptions): string {
  if (!permalink) return '';
  const internal = opts.wooBaseUrl.replace(/\/+$/, '');
  const pub = opts.storeUrl.replace(/\/+$/, '');
  if (internal && pub && internal !== pub && permalink.startsWith(internal)) {
    return `${pub}${permalink.slice(internal.length)}`;
  }
  return permalink;
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export function productSummary(p: WooProduct, opts: PermalinkOptions): ProductSummary {
  return {
    id: p.id,
    name: str(p.name),
    sku: str(p.sku),
    price: str(p.price),
    regular_price: str(p.regular_price),
    status: str(p.status),
    stock_status: str(p.stock_status),
    permalink: publicPermalink(p.permalink, opts),
    date_created: str(p.date_created),
  };
}

export function productDetail(p: WooProduct, opts: PermalinkOptions): ProductDetail {
  const totalSales = typeof p.total_sales === 'string' ? Number.parseInt(p.total_sales, 10) : p.total_sales;
  return {
    ...productSummary(p, opts),
    type: str(p.type ?? 'simple'),
    sale_price: str(p.sale_price),
    description: str(p.description),
    short_description: str(p.short_description),
    manage_stock: Boolean(p.manage_stock),
    stock_quantity: typeof p.stock_quantity === 'number' ? p.stock_quantity : null,
    total_sales: Number.isFinite(totalSales) ? (totalSales as number) : 0,
    categories: (p.categories ?? []).map((c) => ({ id: c.id, name: str(c.name) })),
    date_modified: p.date_modified ?? null,
  };
}

/** Billing first + last name, falling back to "Guest" when both are blank. */
export function customerName(o: Pick<WooOrder, 'billing'>): string {
  const b = o.billing ?? {};
  const name = [b.first_name, b.last_name]
    .map((s) => str(s).trim())
    .filter(Boolean)
    .join(' ');
  return name || 'Guest';
}

function lineItemSummary(li: WooLineItem): LineItemSummary {
  return { name: str(li.name), quantity: Number(li.quantity) || 0, total: str(li.total) };
}

export function orderSummary(o: WooOrder): OrderSummary {
  return {
    id: o.id,
    number: str(o.number ?? o.id),
    status: str(o.status),
    total: str(o.total),
    currency: str(o.currency),
    date_created: str(o.date_created),
    customer_name: customerName(o),
    customer_email: str(o.billing?.email),
    payment_method_title: str(o.payment_method_title),
    line_items: (o.line_items ?? []).map(lineItemSummary),
  };
}

function addressSummary(a: WooAddress | undefined): AddressSummary {
  const x = a ?? {};
  const name = [x.first_name, x.last_name]
    .map((s) => str(s).trim())
    .filter(Boolean)
    .join(' ');
  return {
    name,
    company: str(x.company),
    email: str(x.email),
    phone: str(x.phone),
    address_1: str(x.address_1),
    address_2: str(x.address_2),
    city: str(x.city),
    state: str(x.state),
    postcode: str(x.postcode),
    country: str(x.country),
  };
}

function lineItemDetail(li: WooLineItem): LineItemDetail {
  return {
    id: li.id,
    name: str(li.name),
    sku: str(li.sku),
    quantity: Number(li.quantity) || 0,
    price: str(li.price),
    total: str(li.total),
  };
}

/** Number of decimals used by a money string: "12.00" -> 2, "1" -> 0 (zero-decimal currencies such as JPY). */
function decimalsOf(money: string): number {
  const i = money.indexOf('.');
  return i === -1 ? 0 : money.length - i - 1;
}

/**
 * WooCommerce orders have no `subtotal` field; it is the sum of the line item
 * subtotals (before discounts, shipping and tax), formatted like `total`.
 */
export function orderSubtotal(o: WooOrder): string {
  const items = o.line_items ?? [];
  const sum = items.reduce((acc, li) => acc + (Number.parseFloat(str(li.subtotal ?? li.total)) || 0), 0);
  return sum.toFixed(decimalsOf(str(o.total)));
}

export function orderDetail(o: WooOrder): OrderDetail {
  return {
    id: o.id,
    number: str(o.number ?? o.id),
    status: str(o.status),
    currency: str(o.currency),
    total: str(o.total),
    subtotal: orderSubtotal(o),
    shipping_total: str(o.shipping_total ?? '0'),
    total_tax: str(o.total_tax ?? '0'),
    discount_total: str(o.discount_total ?? '0'),
    payment_method: str(o.payment_method),
    payment_method_title: str(o.payment_method_title),
    date_created: str(o.date_created),
    date_paid: o.date_paid ?? null,
    date_completed: o.date_completed ?? null,
    customer_id: typeof o.customer_id === 'number' ? o.customer_id : 0,
    customer_note: str(o.customer_note),
    billing: addressSummary(o.billing),
    shipping: addressSummary(o.shipping),
    line_items: (o.line_items ?? []).map(lineItemDetail),
  };
}

export function orderNoteSummary(n: WooOrderNote): OrderNoteSummary {
  return { id: n.id, note: str(n.note), date_created: str(n.date_created), customer_note: Boolean(n.customer_note) };
}
