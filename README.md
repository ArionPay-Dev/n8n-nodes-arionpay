# n8n-nodes-arionpay

[ArionPay](https://arionpay.com) crypto payments in [n8n](https://n8n.io): create invoices, read them, and run workflows when a payment arrives. Customers pay Bitcoin, USDT, Litecoin, Ethereum, TRON and more straight to your own wallet: ArionPay never holds the money.

One node, **ArionPay**:

- **Invoice**: create an invoice (and get its payment page address), read an invoice, simulate a test payment.
- **Webhook**: **Verify Webhook** checks a payment update that n8n's own **Webhook** node received and passes on the events you want, for example **Invoice Paid**. **Send Test Event** asks ArionPay for a signed sample event.
- **Coin and Rate**: list the coins ArionPay takes, and coin prices.

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
| Webhook Signing Secret | **Webhooks** page, **signing secret** (needed by Verify Webhook) | `whsec_` |
| ArionPay Address | leave `https://merchant.arionpay.com` | |

**Test** sends one signed request to ArionPay (`GET /api/v1/store`), which changes nothing. Wrong keys show "Authorization failed - please check your credentials".

The credentials sign every request with the API secret (the secret itself is never sent), so n8n's **HTTP Request** node can also call the ArionPay API: choose **Authentication > Predefined Credential Type > ArionPay API**.

## Receive payment updates

Payment updates come in through n8n's own **Webhook** node, and **ArionPay > Verify Webhook** checks them:

1. Add a **Webhook** node: **HTTP Method** `POST`, **Respond** `When Last Node Finishes`, **Response Data** `No Response Body`, and under **Options** add **Raw Body** and switch it on.
2. After it, add **ArionPay > Webhook > Verify Webhook** and pick the **Events** you want (default **Invoice Paid**). Keep **Raw Body Field** `data` and **Signature Header** as they are.
3. After that, your steps: send the file, give access, mark the order paid in your sheet... Use `invoice.orderId` or `invoice.metadata` to find the order.
4. Copy the Webhook node's **Production URL**. Paste it into the ArionPay dashboard on the **Webhooks** page (all invoices of the store), or put it in **Callback URL** when you create each invoice. Activate the workflow.

Why those Webhook node settings:

- **Raw Body**: the signature covers the exact bytes ArionPay sent. Without it, Verify Webhook stops with a message that says to switch it on.
- **When Last Node Finishes** and **No Response Body**: a request that fails the check (wrong signing secret, wrong or old signature) makes the workflow fail, so ArionPay gets an error answer and sends the update again later (for about 3 days). You can fix the secret and lose nothing. Events you did not pick end the workflow quietly with a `200` answer. ArionPay waits 10 seconds for the answer: keep the steps after Verify Webhook short, or ArionPay sends the update again (Verify Webhook then skips it as a repeat).

What Verify Webhook does:

- Checks the signature over the exact body, with a 5-minute clock window. Anything else fails the workflow and is never passed on.
- **Invoice Paid** means fully paid and confirmed. That includes late payments, small differences inside your store's payment tolerance (default 1%), and payments you accepted in **Payment Radar**. A payment that is not exact never arrives as paid until you decide in the dashboard.
- Each event is passed on once, even when ArionPay delivers it again. An active workflow remembers the last 300 event ids.
- "Send test webhook" events from the dashboard describe a made-up invoice. They are skipped unless you switch on **Include "Send Test Webhook" Events**, and the output then has `sampleEvent: true`. Never deliver anything for them.
- **Only Test or Only Live Invoices** lets a workflow skip test invoices (or real ones).
- Before you deliver, check that `invoice.amountFiat` and `invoice.currency` are what you asked for, and that `invoice.test` is `false` for real sales. You don't need to check crypto amounts: ArionPay decides whether an invoice is paid.

Output of Verify Webhook:

```json
{
  "eventId": "evt_...",
  "type": "invoice.paid",
  "livemode": true,
  "sampleEvent": false,
  "invoice": { "id": "...", "orderId": "1001", "status": "paid", "amountFiat": 49.9, "currency": "USD", "asset": "USDT_TRC20", "network": "TRON", "paidCrypto": "49.9", "late": false, "test": false, "metadata": {}, "transactions": [] }
}
```

## Example: sell something from a form, deliver when paid

1. **Workflow 1** (for example a Form Trigger): **ArionPay > Invoice > Create** with the price, `Order ID` = your order number and `Idempotency Key` = the same order number, so a retried run never makes a second invoice. Then send the customer the `invoiceUrl` from the output (email, chat, redirect).
2. **Workflow 2**: the Webhook node and **Verify Webhook** as above, then your delivery steps.

To try it without real money, tick **Test Invoice** and fill **Coin** (for example `USDT_TRC20`) when creating. Then use **ArionPay > Invoice > Simulate Test Payment** with **Customer Pays Exactly**, or the **Try a test payment** buttons in the dashboard.

## Upgrading from 1.x

Version 2.0.0 removes the **ArionPay Trigger** node, so that the package can be verified by n8n. A workflow that starts with ArionPay Trigger needs the Webhook node and Verify Webhook instead (see above), with the new Production URL pasted into ArionPay. The output fields are the same.

## Compatibility

Tested on n8n 1.123.96 (Node.js 22), installed the way n8n installs community packages, against a real ArionPay server. Covered: the credential test (right keys, wrong secret, unknown key, wrong address), create, read, idempotent repeat, simulate, send test event, coins, rates, error reporting, payment updates through the Webhook node and Verify Webhook (a real signed invoice.paid, wrong secret, old and missing signatures, Raw Body off, event filters, test events, repeats), and the HTTP Request node with ArionPay credentials (GET, GET with a query, POST). The package uses n8n's standard node interface (API version 1), which n8n 2.x keeps. It also compiles against n8n-workflow 2.16 and passes n8n's community package scanner rules, but it was not run on n8n 2.x here.

## Development

```bash
npm install
npm run build
npm test            # signing and webhook checks
ARIONPAY_TEST_BASE_URL=... ARIONPAY_TEST_KEY=pk_... ARIONPAY_TEST_SECRET=sk_... npm test   # also against a test server
```

MIT licence.
