# n8n-nodes-arionpay

[ArionPay](https://arionpay.com) crypto payments in [n8n](https://n8n.io): create invoices, read them, and start workflows when a payment arrives. Customers pay Bitcoin, USDT, Litecoin, Ethereum, TRON and more straight to your own wallet: ArionPay never holds the money.

Two nodes:

- **ArionPay**: create an invoice (and get its payment page address), read an invoice, simulate a test payment, send a test webhook, list coins and rates.
- **ArionPay Trigger**: starts a workflow when ArionPay sends a signed payment update, for example **Invoice Paid**.

No other packages are needed: requests are signed with Node's own crypto, and n8n's request helper is used.

## Install

In n8n: **Settings > Community Nodes > Install**, enter `n8n-nodes-arionpay`, and confirm.

Self-hosted without the UI: `npm install n8n-nodes-arionpay` in `~/.n8n/nodes`, then restart n8n.

## Credentials

Create **ArionPay API** credentials:

| Field | Where in the ArionPay dashboard | Starts with |
| --- | --- | --- |
| API Key | Open your store, **API key** | `pk_` |
| API Secret | Open your store, **API secret** (asks for your authenticator code) | `sk_` |
| Webhook Signing Secret | **Webhooks** page, **signing secret** (needed by the trigger) | `whsec_` |
| ArionPay Address | leave `https://merchant.arionpay.com` | |

**Test** checks the keys with a signed request.

## Example: sell something from a form, deliver when paid

1. **Workflow 1** (for example a Form Trigger or a Webhook): **ArionPay > Invoice > Create** with the price, `Order ID` = your order number and `Idempotency Key` = the same order number, so a retried run never makes a second invoice. Then send the customer the `invoiceUrl` from the output (email, chat, redirect).
2. **Workflow 2**: **ArionPay Trigger** with the event **Invoice Paid**, then your delivery steps (send the file, give access, mark the order paid in your sheet...). Use `invoice.orderId` or `invoice.metadata` to find the order.
3. Copy the trigger's **Production URL**. Either paste it into the ArionPay dashboard on the **Webhooks** page (all invoices of the store), or put it in **Callback URL** when you create each invoice. Activate workflow 2.

To try it without real money, tick **Test Invoice** and fill **Coin** (for example `USDT_TRC20`) when creating. Then use **ArionPay > Invoice > Simulate Test Payment** with **Customer Pays Exactly**, or the **Try a test payment** buttons in the dashboard.

## The trigger, in short

- Every request is checked: the signature over the exact body, with a 5-minute clock window. Anything else gets `401` and never starts the workflow.
- **Invoice Paid** means fully paid and confirmed. That includes late payments, small differences inside your store's payment tolerance (default 1%), and payments you accepted in **Payment Radar**. A payment that is not exact never arrives as paid until you decide in the dashboard.
- Each event runs the workflow once, even when ArionPay delivers it again (the last 300 event ids are remembered).
- "Send test webhook" events from the dashboard describe a made-up invoice. They are ignored unless you switch on **Include "Send Test Webhook" Events**, and the output then has `sampleEvent: true`. Never deliver anything for them.
- **Only Test or Only Live Invoices** lets a workflow ignore test invoices (or real ones).
- Before you deliver, check that `invoice.amountFiat` and `invoice.currency` are what you asked for, and that `invoice.test` is `false` for real sales. You don't need to check crypto amounts: ArionPay decides whether an invoice is paid.

Output of the trigger:

```json
{
  "eventId": "evt_...",
  "type": "invoice.paid",
  "livemode": true,
  "sampleEvent": false,
  "invoice": { "id": "...", "orderId": "1001", "status": "paid", "amountFiat": 49.9, "currency": "USD", "asset": "USDT_TRC20", "network": "TRON", "paidCrypto": "49.9", "late": false, "test": false, "metadata": {}, "transactions": [] }
}
```

## Compatibility

Tested on n8n 1.123.96 (Node.js 22), installed the way n8n installs community packages, against a real ArionPay server. Covered: the credential test (good and wrong keys), create, read, idempotent repeat, simulate, send test event, coins, rates, and the trigger with real signed webhooks, refused signatures, event filters, test events and duplicates. The package uses n8n's standard node interface (API version 1), which n8n 2.x keeps. It also compiles against n8n-workflow 2.16, but it was not run on n8n 2.x here.

## Development

```bash
npm install
npm run build
npm test            # signing and webhook checks
ARIONPAY_TEST_BASE_URL=... ARIONPAY_TEST_KEY=pk_... ARIONPAY_TEST_SECRET=sk_... npm test   # also against a test server
```

MIT licence.
