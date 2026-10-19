# Thunder Maxit

Facebook growth service website with a password-protected orders dashboard.

## Run locally

1. Make sure Node.js 20 or newer is installed.
2. Either double-click **`start.bat`**, or run this command in the project folder:

   ```bash
   npm start
   ```

3. Open:
   - Website: http://localhost:3000
   - Customer account: http://localhost:3000/account
   - Admin panel: http://localhost:3000/admin

`start.bat` starts the server in its own console window and opens the admin sign-in page. Keep that console window open while using the site; closing it stops the server.

The admin password is stored in `.env` (`ADMIN_PASSWORD`). To change it, edit `.env` and restart the server.

## How orders work

- Payments are **bKash only** (Send Money). The configured number is shown in the order form.
- Customers can create an account from the main website or the order form.
- When a logged-in customer places an order, it is linked to their account and appears under **My Orders** with live progress.
- Guest checkout remains available, but guest orders are not linked to an account and cannot be tracked in My Orders.
- Each order is saved to `data/orders.json`; the customer is then sent to WhatsApp with the order details.
- The customer must send the **payment screenshot on WhatsApp** for verification. New orders show **Payment verification pending** until the admin verifies payment and marks the order Processing.
- Customer accounts are stored in `data/customers.json`; passwords are salted and scrypt-hashed, never stored as plain text.
- Only someone with the admin password can open `/admin` and see all orders. Customers only receive their own orders through the authenticated customer API.
- The public website does not link to the admin panel.
- Orders placed while opening `index.html` directly as a file are **not** saved. Use the Node server.

Back up **both** `data/orders.json` and `data/customers.json` regularly.

The order form also sends the same details to WhatsApp, so WhatsApp remains the customer confirmation channel. The admin dashboard is an additional private record of website orders. Orders placed before this backend was added are not imported automatically.

When changing package prices, update the `PACKAGES` values in **both** `index.html` and `server.js` so the customer message and admin record stay consistent.

## Production notes

- Use HTTPS. It protects the admin password and session cookie.
- Set `ADMIN_PASSWORD` in your hosting provider's secret/environment settings.
- Make sure the `data/` directory (or the path in `DATA_DIR`) is on a **persistent disk**. Serverless hosts with temporary filesystems can lose order files when the app restarts.
- Use a single server instance unless you replace the JSON store with a shared database.
- Set `TRUST_PROXY=true` only if your hosting provider runs a trusted reverse proxy.

## Configuration

| Variable | Description |
| --- | --- |
| `ADMIN_PASSWORD` | Required. Minimum 12 characters. |
| `PORT` | HTTP port, default `3000`. |
| `HOST` | Bind address, default `0.0.0.0`. |
| `DATA_DIR` | Order and customer data directory, default `./data`. |
| `SESSION_TTL_HOURS` | Admin session lifetime, default `12`. |
| `CUSTOMER_SESSION_TTL_DAYS` | Customer login lifetime, default `30`. |
| `TRUST_PROXY` | Set to `true` behind a trusted reverse proxy. |

## Public site settings

Business details are in `index.html`, inside the `CONFIG` block near the bottom of the file. The WhatsApp/phone and bKash number are currently set to `01581415069` (WhatsApp international format: `8801581415069`). Only the Facebook page URL/handle is still a placeholder.

The customer account page uses the same WhatsApp support number in `account.html` for payment screenshot links.
