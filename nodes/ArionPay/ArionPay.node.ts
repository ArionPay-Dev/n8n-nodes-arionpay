import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import {
	apiRequest,
	ArionPayApiError,
	eventOutput,
	FIAT_CURRENCIES,
	newIdempotencyKey,
	normalizeCreated,
	normalizeInvoiceRead,
	skipReason,
	verifyWebhook,
	type ArionPayCredentials,
	type Transport,
} from './GenericFunctions';

const SCENARIOS = [
	{ name: 'Customer Pays Exactly', value: 'exact' },
	{ name: 'Payment Seen (Waiting for Confirmations)', value: 'detected' },
	{ name: 'Confirm the Seen Payment', value: 'confirm' },
	{ name: 'Customer Pays 1% Less', value: 'underpaid_1pct' },
	{ name: 'Customer Pays 5% Less', value: 'underpaid_5pct' },
	{ name: 'Customer Pays Too Much', value: 'overpaid' },
	{ name: 'Customer Pays Half', value: 'partial_half' },
	{ name: 'Customer Pays Too Late', value: 'late' },
];

const EVENT_OPTIONS = [
	{ name: 'Invoice Paid', value: 'invoice.paid' },
	{ name: 'Invoice Pending (Payment Seen)', value: 'invoice.pending' },
	{ name: 'Invoice Partial', value: 'invoice.partial' },
	{ name: 'Invoice Expired', value: 'invoice.expired' },
	{ name: 'Invoice Needs Review', value: 'invoice.needs_review' },
];

const isInvoiceId = (id: string) => /^[0-9a-fA-F]{24}$/.test(id);

const MAX_BODY_BYTES = 262144;
const REMEMBERED_EVENTS = 300;

export class ArionPay implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'ArionPay',
		name: 'arionPay',
		icon: { light: 'file:arionpay.svg', dark: 'file:arionpay.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Crypto payments paid straight to your own wallet: create and read invoices, check payment webhooks',
		defaults: { name: 'ArionPay' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: 'arionPayApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Invoice', value: 'invoice' },
					{ name: 'Webhook', value: 'webhook' },
					{ name: 'Coin and Rate', value: 'info' },
				],
				default: 'invoice',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['invoice'] } },
				options: [
					{ name: 'Create', value: 'create', description: 'Create an invoice and get its payment page address', action: 'Create an invoice' },
					{ name: 'Get', value: 'get', description: 'Read an invoice (signed, straight from ArionPay)', action: 'Get an invoice' },
					{ name: 'Simulate Test Payment', value: 'simulate', description: 'Test mode only: move a test invoice through a payment', action: 'Simulate a test payment' },
				],
				default: 'create',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['webhook'] } },
				options: [
					{ name: 'Send Test Event', value: 'sendTest', description: "Ask ArionPay to send a signed sample event to your store's webhook address", action: 'Send a test webhook event' },
					{
						name: 'Verify Webhook',
						value: 'verify',
						description: "Check the signature of a payment update that n8n's Webhook node received, and pass on the events you want",
						action: 'Verify a webhook',
					},
				],
				default: 'sendTest',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['info'] } },
				options: [
					{ name: 'Get Coins', value: 'currencies', description: 'Coins and networks ArionPay takes right now', action: 'Get coins' },
					{ name: 'Get Rates', value: 'rates', description: 'Coin prices in a currency', action: 'Get rates' },
				],
				default: 'currencies',
			},

			// invoice: create
			{
				displayName: 'Amount',
				name: 'amount',
				type: 'string',
				required: true,
				default: '',
				placeholder: '49.90',
				description: 'Price in the currency below',
				displayOptions: { show: { resource: ['invoice'], operation: ['create'] } },
			},
			{
				displayName: 'Currency',
				name: 'currency',
				type: 'options',
				options: FIAT_CURRENCIES.map((c) => ({ name: c, value: c })),
				default: 'USD',
				displayOptions: { show: { resource: ['invoice'], operation: ['create'] } },
			},
			{
				displayName: 'Test Invoice',
				name: 'test',
				type: 'boolean',
				default: false,
				description: 'Whether to make a test invoice (no real money). Use "Simulate Test Payment" to pay it.',
				displayOptions: { show: { resource: ['invoice'], operation: ['create'] } },
			},
			{
				displayName: 'Additional Fields',
				name: 'additionalFields',
				type: 'collection',
				placeholder: 'Add Field',
				default: {},
				displayOptions: { show: { resource: ['invoice'], operation: ['create'] } },
				options: [
					{ displayName: 'Allowed Coins', name: 'allowedAssets', type: 'string', default: '', placeholder: 'BTC, LTC, USDT_TRC20', description: 'Comma-separated list of coins the customer may choose' },
					{
						displayName: 'Callback URL',
						name: 'callbackUrl',
						type: 'string',
						default: '',
						description: 'Where ArionPay sends this invoice\'s payment updates, e.g. the Production URL of an ArionPay Trigger node',
					},
					{ displayName: 'Cancel URL', name: 'cancelUrl', type: 'string', default: '', description: 'Where the customer goes when they leave without paying' },
					{ displayName: 'Coin', name: 'asset', type: 'string', default: '', placeholder: 'USDT_TRC20', description: 'Choose the coin for the customer (see Get Coins)' },
					{ displayName: 'Description', name: 'description', type: 'string', default: '' },
					{
						displayName: 'Idempotency Key',
						name: 'idempotencyKey',
						type: 'string',
						default: '',
						description: 'The same key always returns the same invoice, so a retried workflow never makes a second one. Use something like your order number.',
					},
					{ displayName: 'Metadata (JSON)', name: 'metadata', type: 'json', default: '{}', description: 'Your own data, sent back in every webhook for this invoice' },
					{ displayName: 'Order ID', name: 'orderId', type: 'string', default: '', description: 'Your own order number, shown in ArionPay' },
					{ displayName: 'Success URL', name: 'successUrl', type: 'string', default: '', description: 'Where the customer goes after paying' },
					{ displayName: 'Time to Pay (Minutes)', name: 'expiresMin', type: 'number', default: 60, typeOptions: { minValue: 5, maxValue: 1440 } },
				],
			},

			// invoice: get / simulate
			{
				displayName: 'Invoice ID',
				name: 'invoiceId',
				type: 'string',
				required: true,
				default: '',
				description: 'The 24-character invoice ID ArionPay returned',
				displayOptions: { show: { resource: ['invoice'], operation: ['get', 'simulate'] } },
			},
			{
				displayName: 'Scenario',
				name: 'scenario',
				type: 'options',
				options: SCENARIOS,
				default: 'exact',
				description: 'Works on test invoices only. A coin must be chosen first (on the payment page, or with the Coin field when creating).',
				displayOptions: { show: { resource: ['invoice'], operation: ['simulate'] } },
			},

			// webhook: send test
			{
				displayName: 'Event',
				name: 'eventType',
				type: 'options',
				options: EVENT_OPTIONS,
				default: 'invoice.paid',
				displayOptions: { show: { resource: ['webhook'], operation: ['sendTest'] } },
			},

			// webhook: verify
			{
				displayName:
					"Put this after n8n's Webhook node: HTTP Method POST, Respond 'When Last Node Finishes', Response Data 'No Response Body', and under Options switch on Raw Body. Paste the Webhook node's Production URL into ArionPay: dashboard > Webhooks, or the Callback URL of each invoice. The credentials need the webhook signing secret.",
				name: 'verifyNotice',
				type: 'notice',
				default: '',
				displayOptions: { show: { resource: ['webhook'], operation: ['verify'] } },
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				options: [
					{ name: 'Invoice Expired', value: 'invoice.expired', description: 'Time to pay ran out without full payment' },
					{ name: 'Invoice Needs Review', value: 'invoice.needs_review', description: 'Payment Radar: you decide in the dashboard' },
					{ name: 'Invoice Paid', value: 'invoice.paid', description: 'Fully paid and confirmed (also late payments and payments you accepted in Payment Radar)' },
					{ name: 'Invoice Partial', value: 'invoice.partial', description: 'Part of the amount was paid' },
					{ name: 'Invoice Pending', value: 'invoice.pending', description: 'Payment seen, waiting for network confirmations' },
				],
				default: ['invoice.paid'],
				required: true,
				description: 'Events that are passed on. Other verified events end the workflow quietly (ArionPay still gets its answer).',
				displayOptions: { show: { resource: ['webhook'], operation: ['verify'] } },
			},
			{
				displayName: 'Raw Body Field',
				name: 'binaryPropertyName',
				type: 'string',
				default: 'data',
				required: true,
				description: "The binary field holding the exact body ArionPay sent. The Webhook node puts it in 'data' when Raw Body is on.",
				displayOptions: { show: { resource: ['webhook'], operation: ['verify'] } },
			},
			{
				displayName: 'Signature Header',
				name: 'signatureHeader',
				type: 'string',
				default: '={{ $json.headers["arionpay-signature"] }}',
				required: true,
				description: 'The ArionPay-Signature header of the request',
				displayOptions: { show: { resource: ['webhook'], operation: ['verify'] } },
			},
			{
				displayName: 'Options',
				name: 'verifyOptions',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				displayOptions: { show: { resource: ['webhook'], operation: ['verify'] } },
				options: [
					{
						displayName: 'Include "Send Test Webhook" Events',
						name: 'includeTestEvents',
						type: 'boolean',
						default: false,
						description: 'Whether to also pass on the sample events of the dashboard button. They describe a made-up invoice: never deliver anything for them.',
					},
					{
						displayName: 'Only Test or Only Live Invoices',
						name: 'mode',
						type: 'options',
						options: [
							{ name: 'Both', value: 'both' },
							{ name: 'Only Live (Real Money)', value: 'live' },
							{ name: 'Only Test', value: 'test' },
						],
						default: 'both',
					},
				],
			},

			// info: rates
			{
				displayName: 'Currency',
				name: 'rateCurrency',
				type: 'options',
				options: FIAT_CURRENCIES.map((c) => ({ name: c, value: c })),
				default: 'USD',
				displayOptions: { show: { resource: ['info'], operation: ['rates'] } },
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];
		const creds = (await this.getCredentials('arionPayApi')) as unknown as ArionPayCredentials;
		const send: Transport = async (req) => {
			const res = (await this.helpers.httpRequest({
				method: req.method,
				url: req.url,
				headers: req.headers,
				body: req.body,
				json: false,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				timeout: 20000,
			})) as { statusCode: number; body: unknown };
			return { status: Number(res.statusCode), body: res.body };
		};

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				let result: IDataObject | IDataObject[];

				if (resource === 'invoice' && operation === 'create') {
					const amount = String(this.getNodeParameter('amount', i)).trim().replace(',', '.');
					if (!/^\d+(\.\d{1,8})?$/.test(amount) || Number(amount) <= 0) {
						throw new NodeOperationError(this.getNode(), `Amount must be a positive number like 49.90 (got "${amount}").`, { itemIndex: i });
					}
					const extra = this.getNodeParameter('additionalFields', i, {}) as IDataObject;
					const body: IDataObject = {
						amount,
						currency: this.getNodeParameter('currency', i) as string,
						idempotencyKey: String(extra.idempotencyKey ?? '').trim() || newIdempotencyKey(),
					};
					if (this.getNodeParameter('test', i, false) as boolean) body.test = true;
					for (const k of ['orderId', 'description', 'successUrl', 'cancelUrl', 'callbackUrl', 'asset']) {
						if (typeof extra[k] === 'string' && (extra[k] as string).trim() !== '') body[k] = (extra[k] as string).trim();
					}
					if (typeof extra.allowedAssets === 'string' && extra.allowedAssets.trim() !== '') {
						body.allowedAssets = extra.allowedAssets.split(',').map((s) => s.trim()).filter(Boolean);
					}
					if (extra.expiresMin !== undefined) body.expiresMin = Number(extra.expiresMin);
					if (extra.metadata !== undefined && extra.metadata !== '' && extra.metadata !== '{}') {
						let meta: unknown = extra.metadata;
						if (typeof meta === 'string') {
							try {
								meta = JSON.parse(meta);
							} catch {
								throw new NodeOperationError(this.getNode(), 'Metadata must be valid JSON.', { itemIndex: i });
							}
						}
						if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw new NodeOperationError(this.getNode(), 'Metadata must be a JSON object.', { itemIndex: i });
						body.metadata = meta as IDataObject;
					}
					result = normalizeCreated(await apiRequest(send, creds, 'POST', '/api/v1/invoices', body));
				} else if (resource === 'invoice' && (operation === 'get' || operation === 'simulate')) {
					const id = String(this.getNodeParameter('invoiceId', i)).trim();
					if (!isInvoiceId(id)) throw new NodeOperationError(this.getNode(), 'Invoice ID must be the 24-character ID ArionPay returned.', { itemIndex: i });
					if (operation === 'get') {
						result = normalizeInvoiceRead(await apiRequest(send, creds, 'GET', `/api/v1/invoices/${id}`));
					} else {
						const scenario = this.getNodeParameter('scenario', i) as string;
						result = await apiRequest(send, creds, 'POST', `/api/v1/invoices/${id}/simulate`, { scenario });
					}
				} else if (resource === 'webhook' && operation === 'verify') {
					const secret = String(creds.webhookSecret ?? '').trim();
					if (!secret) throw new NodeOperationError(this.getNode(), 'The webhook signing secret is empty in the ArionPay credentials (dashboard > Webhooks > signing secret).', { itemIndex: i });
					const field = String(this.getNodeParameter('binaryPropertyName', i, 'data')).trim() || 'data';
					if (!items[i].binary?.[field]) {
						throw new NodeOperationError(this.getNode(), `No raw body in the binary field "${field}". In the Webhook node, switch on Options > Raw Body.`, { itemIndex: i });
					}
					// The signature covers the exact bytes ArionPay sent, never a re-serialised object.
					const raw = await this.helpers.getBinaryDataBuffer(i, field);
					if (raw.length > MAX_BODY_BYTES) throw new NodeOperationError(this.getNode(), 'The webhook body is too large to be from ArionPay.', { itemIndex: i });
					const header = String(this.getNodeParameter('signatureHeader', i, '') ?? '');
					const { event, error } = verifyWebhook(raw, header, secret);
					if (!event) throw new NodeOperationError(this.getNode(), `Not a valid ArionPay webhook: ${error}`, { itemIndex: i });
					const opts = this.getNodeParameter('verifyOptions', i, {}) as IDataObject;
					const skip = skipReason(event, {
						events: this.getNodeParameter('events', i, []) as string[],
						includeTestEvents: opts.includeTestEvents === true,
						mode: String(opts.mode ?? 'both'),
					});
					if (skip) continue;
					// ArionPay delivers again when an answer is lost: pass each event on once (active workflows remember the last ids).
					const store = this.getWorkflowStaticData('node') as { seen?: string[] };
					const seen = Array.isArray(store.seen) ? store.seen : [];
					if (seen.includes(String(event.id))) continue;
					store.seen = [...seen, String(event.id)].slice(-REMEMBERED_EVENTS);
					result = eventOutput(event);
				} else if (resource === 'webhook' && operation === 'sendTest') {
					result = await apiRequest(send, creds, 'POST', '/api/v1/webhooks/test', { eventType: this.getNodeParameter('eventType', i) as string });
				} else if (resource === 'info' && operation === 'currencies') {
					const r = await apiRequest(send, creds, 'GET', '/api/v1/currencies', undefined, false);
					result = Array.isArray(r.currencies) ? (r.currencies as IDataObject[]) : [];
				} else if (resource === 'info' && operation === 'rates') {
					const cur = this.getNodeParameter('rateCurrency', i) as string;
					result = await apiRequest(send, creds, 'GET', `/api/v1/rates?currency=${encodeURIComponent(cur)}`, undefined, false);
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown operation ${resource}/${operation}.`, { itemIndex: i });
				}

				for (const json of Array.isArray(result) ? result : [result]) out.push({ json, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				// An answer from ArionPay keeps its HTTP status and body in the n8n error view.
				if (error instanceof ArionPayApiError && error.status > 0) {
					throw new NodeApiError(this.getNode(), error.body as JsonObject, { message: error.message, httpCode: String(error.status), itemIndex: i });
				}
				// A NodeOperationError is passed on as it is; anything else becomes one.
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}
		return [out];
	}
}
