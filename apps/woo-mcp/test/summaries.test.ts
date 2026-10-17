import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  customerName,
  orderDetail,
  orderSubtotal,
  orderSummary,
  productDetail,
  productSummary,
  publicPermalink,
} from '../src/summaries.ts';
import type { WooOrder, WooProduct } from '../src/woo/types.ts';

const links = { wooBaseUrl: 'http://demo-wordpress:80', storeUrl: 'http://store.127.0.0.1.nip.io' };

const product: WooProduct = {
  id: 7,
  name: 'Demo Mug',
  permalink: 'http://demo-wordpress:80/product/demo-mug/',
  type: 'simple',
  status: 'publish',
  sku: 'MUG-1',
  price: '12.00',
  regular_price: '12.00',
  sale_price: '',
  description: '<p>A mug</p>',
  short_description: 'Mug',
  manage_stock: true,
  stock_quantity: 5,
  stock_status: 'instock',
  total_sales: '3',
  categories: [{ id: 15, name: 'Uncategorized', slug: 'uncategorized' }],
  date_created: '2026-10-16T09:00:00',
  date_modified: '2026-10-16T09:30:00',
};

const order: WooOrder = {
  id: 42,
  number: '42',
  status: 'processing',
  currency: 'USD',
  total: '27.50',
  total_tax: '2.50',
  shipping_total: '5.00',
  discount_total: '0.00',
  payment_method: 'cod',
  payment_method_title: 'Cash on delivery',
  customer_id: 3,
  customer_note: 'Leave at the door',
  date_created: '2026-10-16T10:00:00',
  date_paid: null,
  date_completed: null,
  billing: {
    first_name: 'Ada',
    last_name: 'Lovelace',
    address_1: '1 Analytical Way',
    city: 'London',
    postcode: 'N1',
    country: 'GB',
    email: 'ada@example.com',
    phone: '+44 20 0000',
  },
  shipping: { first_name: 'Ada', last_name: 'Lovelace', address_1: '1 Analytical Way', city: 'London', country: 'GB' },
  line_items: [
    { id: 1, name: 'Demo Mug', product_id: 7, quantity: 2, sku: 'MUG-1', price: 10, subtotal: '20.00', total: '20.00' },
  ],
};

describe('summaries.publicPermalink', () => {
  test('rewrites internal origins to the public storefront', () => {
    assert.equal(publicPermalink('http://demo-wordpress:80/product/demo-mug/', links), 'http://store.127.0.0.1.nip.io/product/demo-mug/');
  });
  test('leaves other permalinks alone', () => {
    assert.equal(publicPermalink('https://shop.example.com/product/x/', links), 'https://shop.example.com/product/x/');
    assert.equal(publicPermalink(undefined, links), '');
  });
  test('is a no-op when both origins are the same', () => {
    const same = { wooBaseUrl: 'http://a', storeUrl: 'http://a' };
    assert.equal(publicPermalink('http://a/product/x/', same), 'http://a/product/x/');
  });
});

describe('summaries.product', () => {
  test('productSummary has exactly the contract fields', () => {
    const s = productSummary(product, links);
    assert.deepEqual(Object.keys(s).sort(), [
      'date_created',
      'id',
      'name',
      'permalink',
      'price',
      'regular_price',
      'sku',
      'status',
      'stock_status',
    ]);
    assert.equal(s.permalink, 'http://store.127.0.0.1.nip.io/product/demo-mug/');
  });
  test('productDetail adds descriptions, stock and categories', () => {
    const d = productDetail(product, links);
    assert.equal(d.total_sales, 3);
    assert.equal(d.stock_quantity, 5);
    assert.equal(d.manage_stock, true);
    assert.deepEqual(d.categories, [{ id: 15, name: 'Uncategorized' }]);
    assert.equal(d.description, '<p>A mug</p>');
    assert.equal(d.date_modified, '2026-10-16T09:30:00');
  });
});

describe('summaries.order', () => {
  test('customerName joins billing names and falls back to Guest', () => {
    assert.equal(customerName(order), 'Ada Lovelace');
    assert.equal(customerName({ billing: { first_name: ' Ada ', last_name: '' } }), 'Ada');
    assert.equal(customerName({ billing: {} }), 'Guest');
    assert.equal(customerName({}), 'Guest');
  });
  test('orderSummary has the contract fields and line item summaries', () => {
    const s = orderSummary(order);
    assert.deepEqual(Object.keys(s).sort(), [
      'currency',
      'customer_email',
      'customer_name',
      'date_created',
      'id',
      'line_items',
      'number',
      'payment_method_title',
      'status',
      'total',
    ]);
    assert.deepEqual(s.line_items, [{ name: 'Demo Mug', quantity: 2, total: '20.00' }]);
    assert.equal(s.customer_email, 'ada@example.com');
  });
  test('orderSubtotal sums line item subtotals with the same decimals as total', () => {
    assert.equal(orderSubtotal(order), '20.00');
    assert.equal(orderSubtotal({ ...order, total: '1', line_items: [] }), '0');
    assert.equal(
      orderSubtotal({
        ...order,
        total: '1.000',
        line_items: [
          { id: 1, name: 'a', quantity: 1, subtotal: '0.500', total: '0.500' },
          { id: 2, name: 'b', quantity: 1, total: '0.250' },
        ],
      }),
      '0.750',
    );
  });
  test('orderDetail flattens addresses and line items', () => {
    const d = orderDetail(order);
    assert.equal(d.subtotal, '20.00');
    assert.equal(d.shipping_total, '5.00');
    assert.equal(d.billing.name, 'Ada Lovelace');
    assert.equal(d.billing.email, 'ada@example.com');
    assert.equal(d.shipping.address_1, '1 Analytical Way');
    assert.equal(d.shipping.email, '');
    assert.deepEqual(d.line_items, [{ id: 1, name: 'Demo Mug', sku: 'MUG-1', quantity: 2, price: '10', total: '20.00' }]);
    assert.equal(d.customer_note, 'Leave at the door');
    assert.equal(d.date_paid, null);
  });
});
