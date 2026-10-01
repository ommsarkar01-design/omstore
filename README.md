# OM STORE

## Run locally

1. Revoke the bot token that was shared in chat and generate a replacement with BotFather.
2. Copy `.env.example` to `.env`; set a private `ADMIN_PASSWORD`, add the replacement token in `TELEGRAM_BOT_TOKEN`, keep the chat ID in `TELEGRAM_CHAT_ID`, and set `ADMIN_CONTACT_NUMBER` for the paid contact service.
3. Open a terminal in this folder and run `node server.js`.
4. Open `http://localhost:8000` in your browser. Send `/start` to your bot before testing notifications.

The `.env` file is ignored by Git. Do not put the bot token or admin passcode in HTML, JavaScript sent to the browser, or messages shared in chat. Restart the server after editing `.env`.

The server's live database is `data/om-store.sqlite` (SQLite). It stores the catalog, orders, service requests, and private admin-contact setting. On first startup, existing `accounts.json`, `orders.json`, and `service-requests.json` records are imported once; those JSON files remain as untouched migration backups. Admin create/edit/delete updates SQLite, and store/checkout pages read the current catalog from the server. The checkout sends buyer details and UTR to Telegram only after consent and when Telegram is configured. Payment status is not verified automatically; confirm transfers in your bank or UPI app. The site is a prototype and does not process payments.

Each checkout receives a server-generated order number. Order status is saved in SQLite, can be looked up on the Help Center page, and is updated by admin Verify/Reject actions. The Help Center uses deterministic status replies; it does not make payment decisions. Back up `data/om-store.sqlite` if you use the local prototype.

The Services page collects consented customer requests into the ignored `data/service-requests.json` file and optionally notifies Telegram when configured. Sell my ID costs ₹100, Source file bind ₹1,000, Double security/unsubscribe ₹2,000, and Contact Admin ₹10; priced services require a UTR and admin verification. Single unsubscribe and Find security service are price-confirmed by admin. The Contact Admin number is returned only after the ₹10 request is verified. Locally, it is in ignored `data/service-config.json`; deployments should set `ADMIN_CONTACT_NUMBER` in their private environment. The Help Center provides automatic status-based replies; it is not connected to a generative AI provider. Other services are requests for admin review, not instant fulfillment.

Current storage note: SQLite is the live source for service requests and admin-contact settings too; earlier JSON paths in this README are one-time migration sources/backups. The local Node server binds to `127.0.0.1`. A public deployment needs a hosted backend/API and HTTPS; static-only hosting cannot keep the bot token secret.