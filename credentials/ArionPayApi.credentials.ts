import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class ArionPayApi implements ICredentialType {
	name = 'arionPayApi';

	displayName = 'ArionPay API';

	documentationUrl = 'https://arionpay.com';

	icon = 'file:arionpay.svg' as const;

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'pk_...',
			description: 'ArionPay dashboard > your store > API key',
		},
		{
			displayName: 'API Secret',
			name: 'apiSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			placeholder: 'sk_...',
			description: 'ArionPay dashboard > your store > API secret',
		},
		{
			displayName: 'Webhook Signing Secret',
			name: 'webhookSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			placeholder: 'whsec_...',
			description: 'ArionPay dashboard > Webhooks > signing secret. Needed by the ArionPay Trigger node.',
		},
		{
			displayName: 'ArionPay Address',
			name: 'baseUrl',
			type: 'string',
			default: 'https://merchant.arionpay.com',
			description: 'Leave as it is unless ArionPay tells you otherwise',
		},
	];
}
