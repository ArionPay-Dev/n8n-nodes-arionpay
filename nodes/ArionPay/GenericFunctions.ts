import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import type { IDataObject, IHttpRequestOptions } from 'n8n-workflow';
import { sleep } from 'n8n-workflow';

/** Credentials as stored in n8n (credentials/ArionPayApi.credentials.ts). */
export interface ArionPayCredentials {
	apiKey: string;
	apiSecret: string;
	webhookSecret?: string;
	baseUrl?: string;
}

export const DEFAULT_BASE_URL = 'https://merchant.arionpay.com';
export const VERSION = '2.0.0';
export const EVENT_TYPES = ['invoice.pending', 'invoice.partial', 'invoice.paid', 'invoice.expired', 'invoice.needs_review'];
export const FIAT_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY', 'TRY', 'AED', 'INR', 'BRL', 'RUB', 'CNY', 'SGD', 'HKD', 'KRW', 'MXN', 'PLN', 'SEK', 'NOK', 'ZAR'];
const TOLERANCE_SEC = 300;

/** One HTTP call, made with n8n's own request helper (so n8n proxies and timeouts apply). */
export type Transport = (req: { method: 'GET' | 'POST'; url: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; body: unknown }>;

export class ArionPayApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body: IDataObject = {},
	) {
		super(message);
	}
}

const hmacHex = (secret: string, data: string | Buffer) => createHmac('sha256', secret).update(data).digest('hex');

/**
 * Request signature: POST = HMAC-SHA256(secret, "<ts>.<raw body>"), GET = HMAC-SHA256(secret, "<ts>.GET <path?query>").
 */
export function signRequest(secret: string, ts: number, method: string, pathAndQuery: string, raw: string): string {
	return method === 'GET' ? hmacHex(secret, `${ts}.GET ${pathAndQuery}`) : hmacHex(secret, `${ts}.${raw}`);
}

function decode(body: unknown): IDataObject {
	if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body as IDataObject;
	const text = Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : '';
	try {
		const v = text ? JSON.parse(text) : {};
		return v && typeof v === 'object' ? (v as IDataObject) : {};
	} catch {
		return {};
	}
}

/** Signed (or public) call to the ArionPay merchant API. Re-signs once when ArionPay says a signature was already used. */
export async function apiRequest(
	send: Transport,
	creds: ArionPayCredentials,
	method: 'GET' | 'POST',
	path: string,
	body?: IDataObject,
	signed = true,
): Promise<IDataObject> {
	const apiKey = String(creds.apiKey ?? '').trim();
	const apiSecret = String(creds.apiSecret ?? '').trim();
	if (signed && !/^pk_[A-Za-z0-9_-]{8,64}$/.test(apiKey)) throw new ArionPayApiError('The API key must be your store API key (it starts with pk_).', 0);
	if (signed && !apiSecret) throw new ArionPayApiError('The API secret is empty (it starts with sk_).', 0);
	const base = new URL(String(creds.baseUrl ?? '').trim() || DEFAULT_BASE_URL);
	if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new ArionPayApiError('The ArionPay address must start with https://', 0);
	const q = path.indexOf('?');
	const url = new URL(base.toString());
	url.pathname = base.pathname.replace(/\/+$/, '') + (q >= 0 ? path.slice(0, q) : path);
	url.search = q >= 0 ? path.slice(q) : '';
	const raw = body === undefined ? undefined : JSON.stringify(body);

	for (let attempt = 1; ; attempt++) {
		const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': `n8n-nodes-arionpay/${VERSION}` };
		if (raw !== undefined) headers['Content-Type'] = 'application/json';
		if (signed) {
			const ts = Math.floor(Date.now() / 1000);
			headers['x-api-key'] = apiKey;
			headers['x-timestamp'] = String(ts);
			headers['x-signature'] = signRequest(apiSecret, ts, method, url.pathname + url.search, raw ?? '');
		}
		// A network failure is reported as an ArionPayApiError with status 0; the node turns it into a NodeOperationError.
		let res: { status: number; body: unknown } | undefined;
		let failure = '';
		try {
			res = await send({ method, url: url.toString(), headers, body: raw });
		} catch (e) {
			failure = String((e as Error)?.message ?? e);
		}
		if (!res) throw new ArionPayApiError(`Could not reach ArionPay: ${failure}`, 0);
		const data = decode(res.body);
		if (res.status >= 200 && res.status < 300) return data;
		const message = typeof data.error === 'string' ? data.error : typeof data.message === 'string' ? data.message : `HTTP ${res.status}`;
		if (res.status === 401 && /already used/i.test(message) && attempt === 1) {
			await sleep(1100); // two identical signed requests in one second: sign again
			continue;
		}
		throw new ArionPayApiError(`ArionPay API error (${res.status}): ${message}`, res.status, data);
	}
}

export function newIdempotencyKey(): string {
	return `n8n_${randomUUID()}`;
}

/** The created invoice in the same names the SDKs use. */
export function normalizeCreated(r: IDataObject): IDataObject {
	const d = (r.data && typeof r.data === 'object' ? r.data : r) as IDataObject;
	return {
		id: String(d.id ?? ''),
		invoiceUrl: String(d.invoice_url ?? ''),
		status: String(d.status ?? 'new'),
		amountFiat: d.amount_fiat !== undefined ? Number(d.amount_fiat) : null,
		currency: String(d.currency ?? ''),
		asset: (d.asset as string) ?? null,
		address: (d.address as string) ?? null,
		amountCrypto: (d.amount_crypto as string) ?? null,
		expiresAt: (d.expires_at as string) ?? null,
		orderId: (d.order_id as string) ?? null,
	};
}

/** The signed read (GET /api/v1/invoices/:id) in the field names of webhook events. */
export function normalizeInvoiceRead(r: IDataObject): IDataObject {
	return {
		id: String(r.invoiceId ?? r.id ?? ''),
		status: String(r.status ?? '').toLowerCase(),
		orderId: (r.orderId as string) ?? null,
		amountFiat: Number(r.amountFiat ?? 0),
		currency: String(r.currency ?? ''),
		asset: String(r.settledCurrency ?? ''),
		network: String(r.network ?? ''),
		amountCrypto: String(r.amountExpected ?? ''),
		paidCrypto: String(r.amountReceived ?? '0'),
		confirmedCrypto: String(r.amountConfirmed ?? '0'),
		overpaid: r.overpaid === true,
		underpaidWithinTolerance: r.underpaidWithinTolerance === true,
		late: r.late === true,
		needsReview: r.needsReview === true,
		manual: r.manual === true,
		test: r.test === true,
		transactions: Array.isArray(r.transactions) ? r.transactions : [],
		metadata: r.metadata && typeof r.metadata === 'object' ? r.metadata : {},
		paidAt: (r.settledAt as string) ?? null,
		txHash: (r.txHash as string) ?? null,
		confirmations: Number(r.confirmations ?? 0),
		requiredConfirmations: Number(r.requiredConfirmations ?? 0),
	};
}

/**
 * Check an ArionPay webhook ("ArionPay-Signature: t=<unix>,v1=<hex HMAC(secret, "<t>.<raw body>")>"). Returns the
 * event, or a reason it must not be trusted.
 */
export function verifyWebhook(raw: Buffer, header: string, secret: string, now = Math.floor(Date.now() / 1000)): { event?: IDataObject; error?: string } {
	if (!secret) return { error: 'The webhook signing secret is empty in the ArionPay credentials.' };
	const parts: Record<string, string> = {};
	for (const p of String(header ?? '').split(',')) {
		const i = p.indexOf('=');
		if (i > 0) parts[p.slice(0, i).trim()] = p.slice(i + 1).trim();
	}
	if (!/^\d{1,12}$/.test(parts.t ?? '') || !/^[0-9a-fA-F]{64}$/.test(parts.v1 ?? '')) return { error: 'Missing or malformed ArionPay-Signature header.' };
	const t = Number(parts.t);
	if (Math.abs(now - t) > TOLERANCE_SEC) return { error: 'Stale signature: check the server clock.' };
	const expected = Buffer.from(hmacHex(secret, Buffer.concat([Buffer.from(`${t}.`, 'utf8'), raw])), 'hex');
	const given = Buffer.from(parts.v1.toLowerCase(), 'hex');
	if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { error: 'Invalid signature: check the webhook signing secret.' };
	let event: IDataObject;
	try {
		event = JSON.parse(raw.toString('utf8')) as IDataObject;
	} catch {
		return { error: 'The body is not JSON.' };
	}
	const data = event?.data as IDataObject | undefined;
	if (!event || typeof event.id !== 'string' || !event.id || typeof event.type !== 'string' || !data || typeof data.invoice !== 'object' || data.invoice === null) {
		return { error: 'The body is not an ArionPay event.' };
	}
	return { event };
}

/** "Send test webhook" events describe a made-up invoice. */
export function isTestEvent(event: IDataObject): boolean {
	const inv = ((event.data as IDataObject)?.invoice ?? {}) as IDataObject;
	return Boolean(event.test) || String(event.id).startsWith('evt_test_') || String(inv.id ?? '').startsWith('inv_test_');
}

export interface EventFilter {
	/** Event types to pass on, e.g. ['invoice.paid']. */
	events: string[];
	/** Also pass on "Send test webhook" sample events (made-up invoice). */
	includeTestEvents?: boolean;
	/** 'live' = only real-money invoices, 'test' = only test invoices, 'both' (default). */
	mode?: string;
}

/** Why a verified event is not passed on, or null when it is wanted. */
export function skipReason(event: IDataObject, filter: EventFilter): string | null {
	const invoice = ((event.data as IDataObject)?.invoice ?? {}) as IDataObject;
	const sample = isTestEvent(event);
	const type = String(event.type);
	if (sample && !filter.includeTestEvents) return 'test event';
	if (!EVENT_TYPES.includes(type)) return 'event type';
	if (!filter.events.includes(type)) return 'event not selected';
	const mode = String(filter.mode ?? 'both');
	if ((mode === 'live' && invoice.test === true) || (mode === 'test' && invoice.test !== true)) return 'test/live mode';
	return null;
}

/** The verified event in the shape the workflow gets. */
export function eventOutput(event: IDataObject): IDataObject {
	const invoice = ((event.data as IDataObject)?.invoice ?? {}) as IDataObject;
	return {
		eventId: event.id,
		type: event.type,
		created: event.created ?? null,
		livemode: event.livemode ?? !invoice.test,
		sampleEvent: isTestEvent(event),
		invoice,
	};
}

/**
 * Signs a request that n8n sends with these credentials (the credential test, or the HTTP Request node with
 * "ArionPay API" credentials). The query is moved into the URL and an object body is sent as the exact JSON
 * string that was signed, so what ArionPay receives is what was signed. The API secret itself is never sent.
 */
export function signN8nRequest(creds: ArionPayCredentials, options: IHttpRequestOptions, now = Math.floor(Date.now() / 1000)): IHttpRequestOptions {
	const legacy = options as IHttpRequestOptions & { uri?: string };
	const target = String(options.url || legacy.uri || '');
	const url = /^https?:\/\//i.test(target)
		? new URL(target)
		: new URL(`${(String(options.baseURL || creds.baseUrl || '').trim() || DEFAULT_BASE_URL).replace(/\/+$/, '')}/${target.replace(/^\/+/, '')}`);
	for (const [key, value] of Object.entries((options.qs ?? {}) as IDataObject)) {
		if (value === undefined || value === null) continue;
		for (const one of Array.isArray(value) ? value : [value]) url.searchParams.append(key, typeof one === 'object' ? JSON.stringify(one) : String(one));
	}
	const method = String(options.method ?? 'GET').toUpperCase();
	const headers: IDataObject = { ...(options.headers ?? {}) };
	const signed: IHttpRequestOptions & { uri?: string } = { ...options, headers };
	delete signed.qs;
	delete signed.baseURL;
	signed.url = url.toString();
	if (legacy.uri !== undefined) signed.uri = url.toString();
	let raw = '';
	if (method !== 'GET' && method !== 'HEAD' && options.body !== undefined && options.body !== null && options.body !== '') {
		const b = options.body as unknown;
		raw = typeof b === 'string' ? b : Buffer.isBuffer(b) ? b.toString('utf8') : JSON.stringify(b);
		signed.body = raw;
		if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
	}
	headers['x-api-key'] = String(creds.apiKey ?? '').trim();
	headers['x-timestamp'] = String(now);
	headers['x-signature'] = signRequest(String(creds.apiSecret ?? '').trim(), now, method, url.pathname + url.search, raw);
	return signed;
}
