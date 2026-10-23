// lib/storephoto.mjs: photo URLs only (og:image, collection, newest product), Shopify CDN at 400 px.
import test from 'node:test';
import assert from 'node:assert';
import { photoFromHtml, photoFromProducts, collectionJsonUrl, looksLikeLogo, sized, storePhotoUrl, photoCache, RETRY_MS } from '../lib/storephoto.mjs';

const BASE = 'https://shop.test/products/dress';
const html = (h) => new Response(h, { status: 200, headers: { 'content-type': 'text/html' } });

test('og:image: protocol-relative, relative and http URLs become absolute https', () => {
  assert.strictEqual(photoFromHtml('<meta property="og:image" content="//shop.test/cdn/shop/files/dress.jpg?v=1">', BASE), 'https://shop.test/cdn/shop/files/dress.jpg?v=1');
  assert.strictEqual(photoFromHtml("<meta content='/cdn/shop/files/a.png' property='og:image'>", BASE), 'https://shop.test/cdn/shop/files/a.png');
  assert.strictEqual(photoFromHtml('<meta property="og:image" content="http://cdn.shopify.com/s/files/1/x.jpg?v=1&amp;width=1200">', BASE), 'https://cdn.shopify.com/s/files/1/x.jpg?v=1&width=1200');
  assert.strictEqual(photoFromHtml('<meta name="twitter:image" content="https://a.test/t.webp">', BASE), 'https://a.test/t.webp');
  assert.strictEqual(photoFromHtml('<meta property="og:title" content="Dress">', BASE), '');
});

test('logos, favicons, icons, placeholders and svg are skipped', () => {
  assert.strictEqual(photoFromHtml('<meta property="og:image" content="/logo.png"><meta name="twitter:image" content="/files/dress.jpg">', BASE), 'https://shop.test/files/dress.jpg');
  for (const u of ['https://a.test/images/icons/cart.png', 'https://a.test/apple-touch-icon.png', 'https://a.test/cdn/shopifycloud/x/no-image.gif', 'https://a.test/x.svg', 'not a url']) assert.ok(looksLikeLogo(u), u);
  assert.ok(!looksLikeLogo('https://a.test/files/silicone-mat.jpg'));
});

test('collections read their first product; products.json answers give the first image', () => {
  assert.strictEqual(collectionJsonUrl('https://shop.test/collections/summer?utm_source=fb'), 'https://shop.test/collections/summer/products.json?limit=1');
  assert.strictEqual(collectionJsonUrl('https://shop.test/de-de/collections/sale/'), 'https://shop.test/collections/sale/products.json?limit=1');
  assert.strictEqual(collectionJsonUrl('https://shop.test/'), '');
  assert.strictEqual(photoFromProducts({ products: [{ images: [{ src: '//cdn.shopify.com/s/files/1/d.jpg?v=3' }] }] }, BASE), 'https://cdn.shopify.com/s/files/1/d.jpg?v=3');
  assert.strictEqual(photoFromProducts({ products: [] }, BASE), '');
});

test('sized: Shopify CDN photos at 400 px, other https photos as they are, anything else dropped', () => {
  assert.strictEqual(sized('https://cdn.shopify.com/s/files/1/x.png?v=1&width=1200&height=628&crop=center'), 'https://cdn.shopify.com/s/files/1/x.png?v=1&width=400');
  assert.strictEqual(sized('https://shop.test/cdn/shop/files/x.jpg?v=1'), 'https://shop.test/cdn/shop/files/x.jpg?v=1&width=400');
  assert.strictEqual(sized('//cdn.shopify.com/s/files/1/y.jpg'), 'https://cdn.shopify.com/s/files/1/y.jpg?width=400');
  assert.strictEqual(sized('https://img.other.test/a.jpg'), 'https://img.other.test/a.jpg');
  assert.strictEqual(sized('javascript:alert(1)'), '');
  assert.strictEqual(sized(''), '');
});

test('storePhotoUrl: collection first, then og:image, then the newest product; once per landing page', async () => {
  const asked = [];
  const doFetch = async (u) => {
    const x = new URL(u);
    asked.push(x.host + x.pathname);
    if (x.pathname === '/collections/sale/products.json') return new Response(JSON.stringify({ products: [{ images: [{ src: 'https://cdn.shopify.com/c.jpg' }] }] }));
    if (x.pathname === '/products.json') return new Response(JSON.stringify({ products: [{ images: [{ src: 'https://cdn.shopify.com/s/files/1/new.jpg' }] }] }));
    if (x.host === 'logo.test') return html('<head><meta property="og:image" content="/cdn/shop/files/shop-logo.png"></head>');
    return html('<html><head><meta property="og:image" content="//shop.test/cdn/shop/files/home.jpg"></head><body>');
  };
  assert.strictEqual(await storePhotoUrl('https://shop.test/collections/sale', doFetch), 'https://cdn.shopify.com/c.jpg?width=400');
  assert.strictEqual(await storePhotoUrl('https://shop.test/', doFetch), 'https://shop.test/cdn/shop/files/home.jpg?width=400');
  assert.strictEqual(await storePhotoUrl('https://logo.test/', doFetch), 'https://cdn.shopify.com/s/files/1/new.jpg?width=400', 'logo skipped → newest product');
  assert.strictEqual(await storePhotoUrl('', doFetch), '');
  const photo = photoCache(doFetch);
  asked.length = 0;
  await photo('https://shop.test/');
  await photo('https://shop.test/');
  assert.strictEqual(asked.length, 1, 'looked up once');
  assert.strictEqual(await photoCache(async () => { throw new Error('down'); })('https://x.test/'), '', 'never throws');
});

test('a store that says 503 is asked once more', async () => {
  RETRY_MS.wait = 1;
  let n = 0;
  const doFetch = async () => (++n === 1 ? new Response('busy', { status: 503 }) : html('<meta property="og:image" content="/cdn/shop/files/dress.jpg">'));
  assert.strictEqual(await storePhotoUrl('https://shop.test/', doFetch), 'https://shop.test/cdn/shop/files/dress.jpg?width=400');
  assert.strictEqual(n, 2);
});
