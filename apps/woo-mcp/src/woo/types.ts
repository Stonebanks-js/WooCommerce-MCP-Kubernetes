/**
 * The subset of WooCommerce REST API (wc/v3) objects this server reads.
 * Field names are WooCommerce's own (snake_case) so the mapping to the REST
 * payloads is one-to-one. Anything not listed here is ignored.
 */

export const PRODUCT_STATUSES = ['publish', 'draft', 'pending', 'private'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const ORDER_STATUSES = [
  'pending',
  'processing',
  'on-hold',
  'completed',
  'cancelled',
  'refunded',
  'failed',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export interface WooCategoryRef {
  id: number;
  name: string;
  slug: string;
}

export interface WooProduct {
  id: number;
  name: string;
  slug?: string;
  permalink: string;
  type?: string;
  status: string;
  sku: string;
  price: string;
  regular_price: string;
  sale_price?: string;
  description?: string;
  short_description?: string;
  manage_stock?: boolean;
  stock_quantity: number | null;
  stock_status: string;
  total_sales?: number | string;
  categories?: WooCategoryRef[];
  date_created: string;
  date_modified?: string;
}

export interface WooAddress {
  first_name?: string;
  last_name?: string;
  company?: string;
  address_1?: string;
  address_2?: string;
  city?: string;
  state?: string;
  postcode?: string;
  country?: string;
  email?: string;
  phone?: string;
}

export interface WooLineItem {
  id: number;
  name: string;
  product_id?: number;
  variation_id?: number;
  quantity: number;
  sku?: string | null;
  /** Unit price; WooCommerce serialises it as a number. */
  price?: number | string;
  subtotal?: string;
  total: string;
}

export interface WooOrder {
  id: number;
  number: string;
  status: string;
  currency: string;
  total: string;
  total_tax?: string;
  shipping_total?: string;
  discount_total?: string;
  payment_method?: string;
  payment_method_title?: string;
  customer_id?: number;
  customer_note?: string;
  date_created: string;
  date_modified?: string;
  date_paid?: string | null;
  date_completed?: string | null;
  billing?: WooAddress;
  shipping?: WooAddress;
  line_items?: WooLineItem[];
}

export interface WooOrderNote {
  id: number;
  author?: string;
  date_created: string;
  note: string;
  customer_note: boolean;
}

/** Body of a WooCommerce / WP REST error response. */
export interface WooErrorBody {
  code?: string;
  message?: string;
  data?: { status?: number; params?: Record<string, string> };
}
