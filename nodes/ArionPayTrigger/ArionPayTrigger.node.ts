import type { IDataObject, INodeType, INodeTypeDescription, IWebhookFunctions, IWebhookResponseData, NodeConnectionType } from 'n8n-workflow';
import { EVENT_TYPES, isTestEvent, verifyWebhook, type ArionPayCredentials } from '../ArionPay/GenericFunctions';

const MAX_BODY_BYTES = 262144;
const REMEMBERED_EVENTS = 300;

export class ArionPayTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'ArionPay Trigger',
		name: 'arionPayTrigger',
		icon: 'file:arionpay.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts the workflow when ArionPay sends a signed payment update (for example: invoice paid)',
		defaults: { name: 'ArionPay Trigger' },
		inputs: [],
		outputs: ['main' as NodeConnectionType],
		credentials: [{ name: 'arionPayApi', required: true }],
		webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' }],
		properties: [
			{
				displayName:
					'Paste this node\'s Production URL into ArionPay: dashboard > Webhooks (for all invoices of the store), or into the Callback URL of each invoice you create. The credentials need the webhook signing secret.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				options: [
					{ name: 'Invoice Paid', value: 'invoice.paid', description: 'Fully paid and confirmed (also late payments and payments you accepted in Payment Radar)' },
					{ name: 'Invoice Pending', value: 'invoice.pending', description: 'Payment seen, waiting for network confirmations' },
					{ name: 'Invoice Partial', value: 'invoice.partial', description: 'Part of the amount was paid' },
					{ name: 'Invoice Expired', value: 'invoice.expired', description: 'Time to pay ran out without full payment' },
					{ name: 'Invoice Needs Review', value: 'invoice.needs_review', description: 'Payment Radar: you decide in the dashboard' },
				],
				default: ['invoice.paid'],
				required: true,
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Include "Send Test Webhook" Events',
						name: 'includeTestEvents',
						type: 'boolean',
						default: false,
						description: 'Whether to also run for the sample events of the dashboard button. They describe a made-up invoice: never deliver anything for them.',
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
		],
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject() as unknown as { rawBody?: Buffer; body?: unknown; headers: Record<string, string | string[] | undefined> };
		const res = this.getResponseObject();
		const reply = (status: number, body: IDataObject): IWebhookResponseData => {
			res.status(status).json(body);
			return { noWebhookResponse: true };
		};

		const creds = (await this.getCredentials('arionPayApi')) as unknown as ArionPayCredentials;
		const secret = String(creds.webhookSecret ?? '').trim();
		if (!secret) return reply(503, { error: 'webhook signing secret is not set in the ArionPay credentials' });

		// The signature covers the exact bytes ArionPay sent, so the raw body is needed (never a re-serialised object).
		const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : typeof req.body === 'string' ? Buffer.from(req.body, 'utf8') : null;
		if (!raw) return reply(400, { error: 'raw body not available' });
		if (raw.length > MAX_BODY_BYTES) return reply(413, { error: 'too large' });
		const header = req.headers['arionpay-signature'];
		const { event, error } = verifyWebhook(raw, Array.isArray(header) ? header[0] : String(header ?? ''), secret);
		if (!event) return reply(401, { error });

		const options = this.getNodeParameter('options', {}) as IDataObject;
		const wanted = this.getNodeParameter('events', []) as string[];
		const invoice = ((event.data as IDataObject).invoice ?? {}) as IDataObject;
		const sample = isTestEvent(event);
		if (sample && !options.includeTestEvents) return reply(200, { received: true, ignored: 'test event' });
		if (!EVENT_TYPES.includes(String(event.type)) && !sample) return reply(200, { received: true, ignored: 'event type' });
		if (!wanted.includes(String(event.type)) && !(sample && wanted.includes(String(event.type)))) return reply(200, { received: true, ignored: 'event not selected' });
		const mode = String(options.mode ?? 'both');
		if ((mode === 'live' && invoice.test === true) || (mode === 'test' && invoice.test !== true)) return reply(200, { received: true, ignored: 'test/live mode' });

		// ArionPay delivers again when an answer is lost: run once per event.
		const store = this.getWorkflowStaticData('node') as { seen?: string[] };
		const seen = Array.isArray(store.seen) ? store.seen : [];
		if (seen.includes(String(event.id))) return reply(200, { received: true, duplicate: true });
		store.seen = [...seen, String(event.id)].slice(-REMEMBERED_EVENTS);

		return {
			workflowData: [
				this.helpers.returnJsonArray([
					{
						eventId: event.id,
						type: event.type,
						created: event.created ?? null,
						livemode: event.livemode ?? !invoice.test,
						sampleEvent: sample,
						invoice,
					},
				]),
			],
		};
	}
}
