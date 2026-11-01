// A fake of CJ Dropshipping's API 2.0 (developers.cjdropshipping.com/api2.0/v1), shaped like its documented answers:
// getAccessToken, product/queryProductsByImage (Level 3 accounts), product/listV2, product/query, the stock by product
// and logistic/freightCalculate (USD). fetch(url, init) answers like the real API; calls lists what was asked.
//   level3: false  the search by photo answers 401, as it does for accounts below Level 3
//   busy: n        the first n calls (after the token) answer 429, as CJ does past about one call a second
export const CJ_KEY = 'CJ1234567@api@0123456789abcdef0123456789abcdef';
export const PID = '1748190816352751616';

const PRODUCTS = [
  { id: PID, nameEn: 'Adjustable Posture Corrector Back Brace', sku: 'CJYD1234567', bigImage: 'https://cf.cjdropshipping.com/posture.jpg', sellPrice: '4.20-5.10', nowPrice: '', weight: '180.00-220.00', listedNum: 3150, warehouseInventoryNum: 12912 },
  { id: '04A22450-67F0-4617-A132-E7AE7F8963B0', nameEn: 'Posture Corrector <b>Pro</b>', sku: 'CJYD7654321', bigImage: 'javascript:alert(1)', sellPrice: '6.80', weight: '250', listedNum: 12 },
  { id: 'bad id with spaces', nameEn: 'Dropped: its id is not one CJ gives' },
];
// The product's variants: the cheapest one is priced and shipped. Stock per country: China, Germany, the US.
const DETAIL = {
  pid: PID, productNameEn: 'Adjustable Posture Corrector Back Brace', productSku: 'CJYD1234567', bigImage: 'https://cf.cjdropshipping.com/posture.jpg', productWeight: '200.0', sellPrice: 4.2,
  variants: [
    { vid: 'V-BLACK-L', pid: PID, variantNameEn: 'Black L', variantSku: 'CJYD1234567-Black-L', variantKey: 'Black-L', variantWeight: 220, variantSellPrice: 5.1,
      inventories: [{ countryCode: 'CN', totalInventory: 900 }] },
    { vid: 'V-BLACK-M', pid: PID, variantNameEn: 'Black M', variantSku: 'CJYD1234567-Black-M', variantKey: 'Black-M', variantWeight: 210, variantSellPrice: 4.2,
      inventories: [{ countryCode: 'CN', totalInventory: 12000 }, { countryCode: 'DE', totalInventory: 120 }, { countryCode: 'US', totalInventory: 40 }] },
  ],
};
// Freight per route: [name, USD, days]. From the German warehouse: dearer per parcel, but no EU import fees.
const FREIGHT = {
  'CN-NL': [['CJPacket Ordinary', 3.95, '8-12'], ['YunExpress', 4.6, '7-10']], 'CN-DE': [['CJPacket Ordinary', 3.7, '7-11']], 'CN-FR': [['CJPacket Ordinary', 4.1, '8-13']],
  'DE-NL': [['DHL Paket', 4.9, '2-4']], 'DE-DE': [['DHL Paket', 3.9, '1-3']], 'DE-FR': [['Colissimo', 6.2, '3-5']],
};

export function fakeCj({ level3 = true, busy = 0 } = {}) {
  const token = 'cj-token-' + Math.random().toString(36).slice(2);
  const calls = [];
  let left = busy;
  const answer = (status, j) => new Response(JSON.stringify(j), { status, headers: { 'Content-Type': 'application/json' } });
  const ok = (data) => answer(200, { code: 200, result: true, message: 'Success', data, requestId: 'req-1', success: true });
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api2\.0\/v1/, '');
    const body = init.body ? JSON.parse(init.body) : null;
    const headers = init.headers || {};
    calls.push({ host: u.host, method: init.method || 'GET', path, query: Object.fromEntries(u.searchParams), body, token: headers['CJ-Access-Token'] || null });
    if (u.host !== 'developers.cjdropshipping.com') throw new Error('unexpected fetch: ' + url);
    if (path === '/authentication/getAccessToken') {
      if (!body || body.apiKey !== CJ_KEY) return answer(200, { code: 1601000, result: false, message: 'User not find', data: null });
      return ok({ openId: 1, accessToken: token, accessTokenExpiryDate: '2027-04-15T09:16:33+08:00', refreshToken: 'refresh', refreshTokenExpiryDate: '2027-04-15T09:16:33+08:00', createDate: '2026-10-17T09:16:33+08:00' });
    }
    if (headers['CJ-Access-Token'] !== token) return answer(401, { code: 1600001, result: false, message: 'Invalid token', data: null });
    if (left > 0) {
      left--;
      return answer(429, { code: 1600200, result: false, message: 'Too much request', data: null });
    }
    if (path === '/product/queryProductsByImage') return level3 ? ok(PRODUCTS.slice(0, 1)) : answer(401, { code: 401, result: false, message: 'Unauthorized', data: null });
    if (path === '/product/listV2') return ok({ pageSize: 10, pageNumber: 1, totalRecords: 3, totalPages: 1, content: [{ productList: PRODUCTS, keyWord: u.searchParams.get('keyWord') }] });
    if (path === '/product/query') return u.searchParams.get('pid') === PID ? ok(DETAIL) : answer(200, { code: 1600100, result: false, message: 'Param error', data: null });
    if (path === '/logistic/freightCalculate') {
      const f = FREIGHT[`${body.startCountryCode}-${body.endCountryCode}`] || [];
      return ok(f.map(([logisticName, logisticPrice, logisticAging]) => ({ logisticName, logisticPrice, logisticAging, logisticPriceCn: logisticPrice * 7 })));
    }
    return answer(404, { code: 404, result: false, message: 'Not found' });
  };
  return { fetch, calls, token };
}
