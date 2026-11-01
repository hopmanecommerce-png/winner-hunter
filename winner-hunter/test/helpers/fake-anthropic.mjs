// A fake of Anthropic's Message Batches API for the AI read's tests: Anthropic's real SDK (@anthropic-ai/sdk) talks to it
// through `fetch`, so the requests are checked as they go over the wire. Nothing leaves the machine.
//   POST /v1/messages/batches                create (the requests are kept)
//   GET  /v1/messages/batches/:id            status: in progress for `endAfter` looks, then ended
//   GET  /v1/messages/batches/:id/results    the results as JSONL, one line per request: answer(request) decides each
//   POST /v1/messages/batches/:id/cancel     cancel
// fail(call): return a Response to answer that call instead (an error, a rate limit…).
export const KEY = 'sk-ant-test-key';
const BASE = 'https://api.anthropic.com';

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
export const apiError = (status, type, message = type) => json({ type: 'error', error: { type, message }, request_id: 'req_test' }, status);

/** A Message as the API returns it, its text the given answer (an object is sent as JSON). */
export function message(answer, { stop = 'end_turn', model = 'claude-haiku-5-5', usage = { input_tokens: 1800, output_tokens: 420 } } = {}) {
  return {
    id: 'msg_test', type: 'message', role: 'assistant', model, stop_reason: stop, stop_sequence: null, stop_details: null,
    content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: typeof answer === 'string' ? answer : JSON.stringify(answer) }],
    usage: { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: 'batch', ...usage },
  };
}

/** A valid read for a request: the product's title in it, a fit from the title's length (so products differ). */
export function goodAnswer(req, extra = {}) {
  const text = req.params.messages[0].content.find((b) => b.type === 'text').text;
  const data = JSON.parse(text.replace(/^<product_data>\n/, '').replace(/\n<\/product_data>$/, ''));
  return {
    injection_suspected: false, product: String(data.title || 'Unknown product').slice(0, 60), niche: 'Home', customer: 'Home owners',
    angle: 'Shows the mess gone in one swipe', wow: 'medium', saturation: 'medium', saturation_hint: 'Several stores run it', claims_risk: 'none', claims: [],
    pros: ['Easy to show on video'], cons: ['Easy to copy'], fit: 30 + (String(data.title || '').length % 60), confidence: 'medium', ...extra,
  };
}

export function fakeAnthropic({ answer = (req) => ({ type: 'succeeded', message: message(goodAnswer(req)) }), endAfter = 0, fail = null } = {}) {
  const batches = new Map();
  const calls = [];
  let seq = 0;
  const now = () => new Date(Date.UTC(2026, 10, 1, 12)).toISOString();
  const view = (b) => {
    const ended = b.canceled || b.looks >= endAfter;
    const counts = { processing: ended ? 0 : b.requests.length, succeeded: 0, errored: 0, canceled: 0, expired: 0 };
    if (ended) for (const r of b.results()) counts[r.result.type === 'succeeded' ? 'succeeded' : r.result.type]++;
    return { id: b.id, type: 'message_batch', processing_status: ended ? 'ended' : 'in_progress', request_counts: counts, created_at: now(), expires_at: now(), ended_at: ended ? now() : null,
      cancel_initiated_at: b.canceled ? now() : null, archived_at: null, results_url: ended ? `${BASE}/v1/messages/batches/${b.id}/results` : null };
  };
  async function doFetch(url, init = {}) {
    const u = new URL(String(url));
    const headers = new Headers(init.headers || {});
    const method = (init.method || 'GET').toUpperCase();
    const body = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : null;
    const call = { method, path: u.pathname, headers, body };
    calls.push(call);
    const failed = fail && (await fail(call));
    if (failed) return failed;
    if (headers.get('authorization') !== `Bearer ${KEY}` && headers.get('x-api-key') !== KEY) return apiError(401, 'authentication_error', 'invalid x-api-key');
    if (u.origin !== BASE) return apiError(404, 'not_found_error');
    const m = /^\/v1\/messages\/batches(?:\/([^/]+))?(?:\/(results|cancel))?$/.exec(u.pathname);
    if (!m) return apiError(404, 'not_found_error');
    if (method === 'POST' && !m[1]) {
      const id = `msgbatch_test${++seq}`;
      const requests = body.requests;
      const b = { id, requests, looks: 0, canceled: false };
      let made = null;
      b.results = () => (made ||= requests.map((req) => ({ custom_id: req.custom_id, result: b.canceled ? { type: 'canceled' } : answer(req) })));
      batches.set(id, b);
      return json(view(b));
    }
    const b = batches.get(m[1]);
    if (!b) return apiError(404, 'not_found_error', 'batch not found');
    if (method === 'POST' && m[2] === 'cancel') {
      b.canceled = true;
      return json(view(b));
    }
    if (method === 'GET' && m[2] === 'results') return new Response(b.results().map((r) => JSON.stringify(r)).join('\n') + '\n', { status: 200, headers: { 'content-type': 'application/binary' } });
    if (method === 'GET' && !m[2]) {
      b.looks++;
      return json(view(b));
    }
    return apiError(405, 'invalid_request_error', 'method not allowed');
  }
  return { fetch: doFetch, batches, calls, creates: () => calls.filter((c) => c.method === 'POST' && c.path === '/v1/messages/batches') };
}
