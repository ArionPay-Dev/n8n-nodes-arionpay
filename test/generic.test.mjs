// Unit tests for the signing and webhook checks (no n8n needed). Optional live part: ARIONPAY_TEST_BASE_URL.
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const g = require("../dist/nodes/ArionPay/GenericFunctions.js");

const sig = (secret, t, raw) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
const ev = { id: "evt_1", type: "invoice.paid", data: { invoice: { id: "a".repeat(24), test: false } } };
const now = 1_800_000_000;

test("request signatures (GET signs the path, POST signs the body)", () => {
  assert.equal(g.signRequest("sk_x", 100, "GET", "/api/v1/invoices/abc", ""), createHmac("sha256", "sk_x").update("100.GET /api/v1/invoices/abc").digest("hex"));
  assert.equal(g.signRequest("sk_x", 100, "POST", "/x", '{"a":1}'), createHmac("sha256", "sk_x").update('100.{"a":1}').digest("hex"));
});

test("webhook: good signature is accepted", () => {
  const raw = JSON.stringify(ev);
  const r = g.verifyWebhook(Buffer.from(raw), sig("whsec_a", now, raw), "whsec_a", now);
  assert.equal(r.error, undefined);
  assert.equal(r.event.id, "evt_1");
});

test("webhook: wrong secret, changed body, old or future time, bad header, empty secret are refused", () => {
  const raw = JSON.stringify(ev);
  assert.match(g.verifyWebhook(Buffer.from(raw), sig("whsec_b", now, raw), "whsec_a", now).error, /Invalid signature/);
  assert.match(g.verifyWebhook(Buffer.from(raw.replace("paid", "pend")), sig("whsec_a", now, raw), "whsec_a", now).error, /Invalid signature/);
  assert.match(g.verifyWebhook(Buffer.from(raw), sig("whsec_a", now - 301, raw), "whsec_a", now).error, /Stale/);
  assert.match(g.verifyWebhook(Buffer.from(raw), sig("whsec_a", now + 301, raw), "whsec_a", now).error, /Stale/);
  assert.match(g.verifyWebhook(Buffer.from(raw), "v1=abc", "whsec_a", now).error, /malformed/);
  assert.match(g.verifyWebhook(Buffer.from(raw), sig("whsec_a", now, raw), "", now).error, /empty/);
});

test("webhook: signed but not an ArionPay event is refused", () => {
  for (const body of ["not json", JSON.stringify({ id: "", type: "invoice.paid", data: { invoice: {} } }), JSON.stringify({ id: "e", type: "x", data: {} })]) {
    assert.ok(g.verifyWebhook(Buffer.from(body), sig("whsec_a", now, body), "whsec_a", now).error);
  }
});

test("test events are recognised", () => {
  assert.equal(g.isTestEvent({ id: "evt_test_1", type: "invoice.paid", data: { invoice: { id: "x" } } }), true);
  assert.equal(g.isTestEvent({ id: "evt_1", type: "invoice.paid", data: { invoice: { id: "inv_test_1" } } }), true);
  assert.equal(g.isTestEvent(ev), false);
});

test("API errors: replayed signature is signed again once; other errors are reported", async () => {
  let calls = 0;
  const send = async (req) => {
    calls++;
    if (calls === 1) return { status: 401, body: '{"error":"Signature already used"}' };
    return { status: 200, body: JSON.stringify({ ok: true, sig: req.headers["x-signature"] }) };
  };
  const r = await g.apiRequest(send, { apiKey: "pk_test_abcdefgh", apiSecret: "sk_x", baseUrl: "https://h" }, "GET", "/api/v1/invoices/" + "a".repeat(24));
  assert.equal(calls, 2);
  assert.equal(r.ok, true);
  await assert.rejects(g.apiRequest(async () => ({ status: 400, body: '{"error":"Bad amount"}' }), { apiKey: "pk_test_abcdefgh", apiSecret: "sk_x" }, "POST", "/api/v1/invoices", { amount: "x" }), /Bad amount/);
  await assert.rejects(g.apiRequest(async () => ({ status: 200, body: "{}" }), { apiKey: "wrong", apiSecret: "sk_x" }, "GET", "/x"), /starts with pk_/);
});

test("base URL with a path keeps the path in the signed request", async () => {
  let seen;
  await g.apiRequest(async (req) => { seen = req; return { status: 200, body: "{}" }; }, { apiKey: "pk_test_abcdefgh", apiSecret: "sk_x", baseUrl: "https://h/prefix/" }, "GET", "/api/v1/rates?currency=EUR", undefined, false);
  assert.equal(seen.url, "https://h/prefix/api/v1/rates?currency=EUR");
});

const creds = { apiKey: " pk_test_abcdefgh ", apiSecret: " sk_x ", baseUrl: "https://h/prefix/" };
const hmac = (data) => createHmac("sha256", "sk_x").update(data).digest("hex");

test("n8n-sent requests: GET with baseURL and qs signs the final path and query", () => {
  const r = g.signN8nRequest(creds, { baseURL: "https://h/prefix/", url: "/api/v1/store", method: "GET", qs: { a: "1 2", b: ["x", "y"] }, headers: { Accept: "application/json" } }, 100);
  assert.equal(r.url, "https://h/prefix/api/v1/store?a=1+2&b=x&b=y");
  assert.equal(r.baseURL, undefined);
  assert.equal(r.qs, undefined);
  assert.equal(r.headers.Accept, "application/json");
  assert.equal(r.headers["x-api-key"], "pk_test_abcdefgh");
  assert.equal(r.headers["x-timestamp"], "100");
  assert.equal(r.headers["x-signature"], hmac("100.GET /prefix/api/v1/store?a=1+2&b=x&b=y"));
});

test("n8n-sent requests: relative URL without baseURL uses the credential address; absolute URL is kept", () => {
  assert.equal(g.signN8nRequest({ ...creds, baseUrl: "" }, { url: "api/v1/store" }, 1).url, "https://merchant.arionpay.com/api/v1/store");
  const r = g.signN8nRequest(creds, { url: "https://other.example/api/v1/invoices/abc", method: "GET" }, 7);
  assert.equal(r.url, "https://other.example/api/v1/invoices/abc");
  assert.equal(r.headers["x-signature"], hmac("7.GET /api/v1/invoices/abc"));
});

test("n8n-sent requests: an object body is sent as the exact JSON string that was signed", () => {
  const r = g.signN8nRequest(creds, { url: "https://h/api/v1/invoices", method: "POST", body: { amount: "5", currency: "USD" }, headers: {} }, 9);
  assert.equal(r.body, '{"amount":"5","currency":"USD"}');
  assert.equal(r.headers["Content-Type"], "application/json");
  assert.equal(r.headers["x-signature"], hmac('9.{"amount":"5","currency":"USD"}'));
  const s = g.signN8nRequest(creds, { uri: "https://h/api/v1/webhooks/test", method: "post", body: '{"eventType":"invoice.paid"}', headers: { "content-type": "application/json" } }, 9);
  assert.equal(s.uri, "https://h/api/v1/webhooks/test");
  assert.equal(s.headers["Content-Type"], undefined);
  assert.equal(s.headers["x-signature"], hmac('9.{"eventType":"invoice.paid"}'));
});

test("verified events: filter by type, test events and live/test mode; output shape", () => {
  const paid = { id: "evt_2", type: "invoice.paid", created: 5, livemode: true, data: { invoice: { id: "b".repeat(24), test: false } } };
  const testInv = { ...paid, id: "evt_3", livemode: false, data: { invoice: { id: "c".repeat(24), test: true } } };
  const sample = { id: "evt_test_1", type: "invoice.paid", test: true, data: { invoice: { id: "inv_test_1", test: true } } };
  assert.equal(g.skipReason(paid, { events: ["invoice.paid"] }), null);
  assert.equal(g.skipReason(paid, { events: ["invoice.expired"] }), "event not selected");
  assert.equal(g.skipReason({ ...paid, type: "invoice.unknown" }, { events: ["invoice.unknown"] }), "event type");
  assert.equal(g.skipReason(sample, { events: ["invoice.paid"] }), "test event");
  assert.equal(g.skipReason(sample, { events: ["invoice.paid"], includeTestEvents: true }), null);
  assert.equal(g.skipReason(testInv, { events: ["invoice.paid"], mode: "live" }), "test/live mode");
  assert.equal(g.skipReason(paid, { events: ["invoice.paid"], mode: "test" }), "test/live mode");
  assert.equal(g.skipReason(testInv, { events: ["invoice.paid"], mode: "test" }), null);
  assert.deepEqual(g.eventOutput(paid), { eventId: "evt_2", type: "invoice.paid", created: 5, livemode: true, sampleEvent: false, invoice: paid.data.invoice });
  assert.equal(g.eventOutput(sample).sampleEvent, true);
  assert.equal(g.eventOutput({ ...testInv, livemode: undefined }).livemode, false);
});

const BASE = process.env.ARIONPAY_TEST_BASE_URL;
test("live: create, read and simulate against an ArionPay test server", { skip: !BASE }, async () => {
  const creds = { apiKey: process.env.ARIONPAY_TEST_KEY, apiSecret: process.env.ARIONPAY_TEST_SECRET, baseUrl: BASE };
  const send = async (req) => { const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body }); return { status: r.status, body: await r.text() }; };
  const created = g.normalizeCreated(await g.apiRequest(send, creds, "POST", "/api/v1/invoices", { amount: "7.50", currency: "EUR", test: true, asset: "USDT_TRC20", idempotencyKey: g.newIdempotencyKey() }));
  assert.match(created.id, /^[0-9a-f]{24}$/);
  assert.match(created.invoiceUrl, /\/pay\//);
  const read = g.normalizeInvoiceRead(await g.apiRequest(send, creds, "GET", `/api/v1/invoices/${created.id}`));
  assert.equal(read.amountFiat, 7.5); assert.equal(read.currency, "EUR"); assert.equal(read.test, true);
  await g.apiRequest(send, creds, "POST", `/api/v1/invoices/${created.id}/simulate`, { scenario: "exact" });
  let status = "";
  for (let i = 0; i < 40 && status !== "paid"; i++) { await new Promise((r) => setTimeout(r, 500)); status = g.normalizeInvoiceRead(await g.apiRequest(send, creds, "GET", `/api/v1/invoices/${created.id}`)).status; }
  assert.equal(status, "paid");
  await assert.rejects(g.apiRequest(send, { ...creds, apiSecret: "sk_wrong" }, "GET", `/api/v1/invoices/${created.id}`), (e) => e.status === 401);
});
