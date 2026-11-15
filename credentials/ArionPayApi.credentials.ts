import type { IAuthenticate, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';
import { signN8nRequest, type ArionPayCredentials } from '../nodes/ArionPay/GenericFunctions';

export class ArionPayApi implements ICredentialType {
	name = 'arionPayApi';

	displayName = 'ArionPay API';

	documentationUrl = 'https://github.com/ArionPay-Dev/n8n-nodes-arionpay#readme';

	icon = { light: 'file:arionpay.svg', dark: 'file:arionpay.dark.svg' } as const;

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
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
			description: 'ArionPay dashboard > Webhooks > signing secret. Needed by the Verify Webhook operation.',
		},
		{
			displayName: 'ArionPay Address',
			name: 'baseUrl',
			type: 'string',
			default: 'https://merchant.arionpay.com',
			description: 'Leave as it is unless ArionPay tells you otherwise',
		},
	];

	// Each request is signed with the API secret (HMAC-SHA256 over the timestamp and the request); the secret is never sent.
	authenticate: IAuthenticate = async (credentials, requestOptions) => signN8nRequest(credentials as unknown as ArionPayCredentials, requestOptions);

	// GET /api/v1/store answers 200 only to a request signed with the right key and secret, and changes nothing.
	// Wrong keys get 401 ("Authorization failed - please check your credentials"), a wrong address 404.
	test: ICredentialTestRequest = {
		request: { baseURL: '={{$credentials.baseUrl}}', url: '/api/v1/store', method: 'GET' },
	};
}
