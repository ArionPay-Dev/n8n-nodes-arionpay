import type {
	ICredentialDataDecryptedObject,
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	IDataObject,
	IExecuteFunctions,
	INodeCredentialTestResult,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	NodeConnectionType,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	apiRequest,
	ArionPayApiError,
	FIAT_CURRENCIES,
	newIdempotencyKey,
	normalizeCreated,
	normalizeInvoiceRead,
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

export class ArionPay implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'ArionPay',
		name: 'arionPay',
		icon: 'file:arionpay.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Crypto payments paid straight to your own wallet: create and read invoices',
		defaults: { name: 'ArionPay' },
		inputs: ['main' as NodeConnectionType],
		outputs: ['main' as NodeConnectionType],
		credentials: [{ name: 'arionPayApi', required: true, testedBy: 'arionPayApiTest' }],
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
				options: [{ name: 'Send Test Event', value: 'sendTest', description: "Ask ArionPay to send a signed sample event to your store's webhook address", action: 'Send a test webhook event' }],
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
					{ displayName: 'Order ID', name: 'orderId', type: 'string', default: '', description: 'Your own order number, shown in ArionPay' },
					{ displayName: 'Description', name: 'description', type: 'string', default: '' },
					{ displayName: 'Success URL', name: 'successUrl', type: 'string', default: '', description: 'Where the customer goes after paying' },
					{ displayName: 'Cancel URL', name: 'cancelUrl', type: 'string', default: '', description: 'Where the customer goes when they leave without paying' },
					{
						displayName: 'Callback URL',
						name: 'callbackUrl',
						type: 'string',
						default: '',
						description: 'Where ArionPay sends this invoice\'s payment updates, e.g. the Production URL of an ArionPay Trigger node',
					},
					{ displayName: 'Coin', name: 'asset', type: 'string', default: '', placeholder: 'USDT_TRC20', description: 'Choose the coin for the customer (see Get Coins)' },
					{ displayName: 'Allowed Coins', name: 'allowedAssets', type: 'string', default: '', placeholder: 'BTC, LTC, USDT_TRC20', description: 'Comma-separated list of coins the customer may choose' },
					{ displayName: 'Time to Pay (Minutes)', name: 'expiresMin', type: 'number', default: 60, typeOptions: { minValue: 5, maxValue: 1440 } },
					{ displayName: 'Metadata (JSON)', name: 'metadata', type: 'json', default: '{}', description: 'Your own data, sent back in every webhook for this invoice' },
					{
						displayName: 'Idempotency Key',
						name: 'idempotencyKey',
						type: 'string',
						default: '',
						description: 'The same key always returns the same invoice, so a retried workflow never makes a second one. Use something like your order number.',
					},
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

	methods = {
		credentialTest: {
			async arionPayApiTest(this: ICredentialTestFunctions, credential: ICredentialsDecrypted): Promise<INodeCredentialTestResult> {
				const creds = (credential.data ?? {}) as ICredentialDataDecryptedObject as unknown as ArionPayCredentials;
				const send: Transport = async (req) => {
					const res = await this.helpers.request({
						method: req.method,
						uri: req.url,
						headers: req.headers,
						body: req.body,
						resolveWithFullResponse: true,
						simple: false,
						json: false,
					});
					return { status: Number(res.statusCode), body: res.body };
				};
				try {
					// A signed read of an invoice that cannot exist: "not found" means the keys were accepted.
					await apiRequest(send, creds, 'GET', '/api/v1/invoices/000000000000000000000000');
					return { status: 'OK', message: 'Connection successful' };
				} catch (e) {
					if (e instanceof ArionPayApiError && e.status === 404) return { status: 'OK', message: 'Connection successful' };
					return { status: 'Error', message: (e as Error).message };
				}
			},
		},
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
				if (error instanceof NodeOperationError) throw error;
				throw new NodeOperationError(this.getNode(), (error as Error).message, { itemIndex: i });
			}
		}
		return [out];
	}
}
