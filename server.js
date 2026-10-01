'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const DATABASE_FILE = path.join(DATA_DIR, 'om-store.sqlite');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const SERVICE_REQUESTS_FILE = path.join(DATA_DIR, 'service-requests.json');
const SERVICE_CONFIG_FILE = path.join(DATA_DIR, 'service-config.json');
const RATE_LIMIT_MS = 5000;
const MAX_BODY_BYTES = 12 * 1024;
const recentSubmissions = new Map();
const failedAdminLogins = new Map();
const adminSessions = new Map();
const orders = new Map();
const serviceRequests = new Map();
let accounts = [];
let adminContactNumber = '';

try {
    process.loadEnvFile(path.join(ROOT, '.env'));
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}

const PORT = Number(process.env.PORT) || 8000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '0987890987';
fs.mkdirSync(DATA_DIR, { recursive: true });
const database = new DatabaseSync(DATABASE_FILE);
database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        level INTEGER NOT NULL,
        rank TEXT NOT NULL,
        price REAL NOT NULL,
        category TEXT NOT NULL,
        status TEXT NOT NULL,
        tag TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
        order_id TEXT PRIMARY KEY,
        listing_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        amount REAL NOT NULL,
        status TEXT NOT NULL,
        utr TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS orders_utr_unique ON orders(utr) WHERE utr IS NOT NULL AND utr <> '';
    CREATE TABLE IF NOT EXISTS service_requests (
        request_id TEXT PRIMARY KEY,
        service_key TEXT NOT NULL,
        service_name TEXT NOT NULL,
        amount REAL,
        utr TEXT,
        status TEXT NOT NULL,
        buyer_name TEXT NOT NULL,
        buyer_phone TEXT NOT NULL,
        buyer_email TEXT NOT NULL,
        buyer_instagram TEXT NOT NULL,
        buyer_game_uid TEXT,
        buyer_notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS service_requests_utr_unique ON service_requests(utr) WHERE utr IS NOT NULL AND utr <> '';
    CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
`);
const MIME_TYPES = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp'
};

function readLegacyArray(filePath) {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!Array.isArray(parsed)) throw new Error(`Expected an array in ${path.basename(filePath)}.`);
        return parsed;
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

function tableIsEmpty(tableName) {
    return database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count === 0;
}

function readLegacyAdminContact() {
    let contactNumber = process.env.ADMIN_CONTACT_NUMBER || '';
    if (contactNumber.startsWith('configure_')) contactNumber = '';
    if (contactNumber) return contactNumber;
    try {
        const config = JSON.parse(fs.readFileSync(SERVICE_CONFIG_FILE, 'utf8'));
        return typeof config.adminContactNumber === 'string' ? config.adminContactNumber.trim() : '';
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return '';
    }
}

const migrationDone = database.prepare('SELECT value FROM app_settings WHERE key = ?').get('legacy_json_import');
if (!migrationDone) {
    const legacyAccounts = readLegacyArray(ACCOUNTS_FILE);
    const legacyOrders = readLegacyArray(ORDERS_FILE);
    const legacyServiceRequests = readLegacyArray(SERVICE_REQUESTS_FILE);
    const insertAccount = database.prepare('INSERT OR IGNORE INTO accounts (id, title, level, rank, price, category, status, tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const insertOrder = database.prepare('INSERT OR IGNORE INTO orders (order_id, listing_id, title, amount, status, utr, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const insertServiceRequest = database.prepare('INSERT OR IGNORE INTO service_requests (request_id, service_key, service_name, amount, utr, status, buyer_name, buyer_phone, buyer_email, buyer_instagram, buyer_game_uid, buyer_notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    database.exec('BEGIN IMMEDIATE');
    try {
        if (tableIsEmpty('accounts')) {
            legacyAccounts.forEach(account => insertAccount.run(account.id, account.title, account.level, account.rank, account.price, account.category, account.status, account.tag));
        }
        if (tableIsEmpty('orders')) {
            legacyOrders.forEach(order => insertOrder.run(order.orderId, order.listingId, order.title, order.amount, order.status, order.utr || null, order.createdAt, order.updatedAt));
        }
        if (tableIsEmpty('service_requests')) {
            legacyServiceRequests.forEach(request => {
                const buyer = request.buyer || {};
                insertServiceRequest.run(request.requestId, request.serviceKey, request.serviceName, request.amount, request.utr || null, request.status, buyer.name || '', buyer.phone || '', buyer.email || '', buyer.instagram || '', buyer.gameUid || '', buyer.notes || '', request.createdAt, request.updatedAt);
            });
        }
        const adminContact = readLegacyAdminContact();
        if (adminContact) database.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)').run('adminContactNumber', adminContact);
        database.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('legacy_json_import', 'complete');
        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}

const configuredAdminContact = process.env.ADMIN_CONTACT_NUMBER || '';
adminContactNumber = configuredAdminContact.startsWith('configure_')
    ? database.prepare('SELECT value FROM app_settings WHERE key = ?').get('adminContactNumber')?.value || ''
    : configuredAdminContact || database.prepare('SELECT value FROM app_settings WHERE key = ?').get('adminContactNumber')?.value || '';
accounts = database.prepare('SELECT id, title, level, rank, price, category, status, tag FROM accounts ORDER BY id').all();
database.prepare('SELECT order_id AS orderId, listing_id AS listingId, title, amount, status, utr, created_at AS createdAt, updated_at AS updatedAt FROM orders').all().forEach(order => orders.set(order.orderId, order));
database.prepare('SELECT request_id AS requestId, service_key AS serviceKey, service_name AS serviceName, amount, utr, status, buyer_name AS buyerName, buyer_phone AS buyerPhone, buyer_email AS buyerEmail, buyer_instagram AS buyerInstagram, buyer_game_uid AS buyerGameUid, buyer_notes AS buyerNotes, created_at AS createdAt, updated_at AS updatedAt FROM service_requests').all().forEach(request => {
    serviceRequests.set(request.requestId, {
        requestId: request.requestId,
        serviceKey: request.serviceKey,
        serviceName: request.serviceName,
        amount: request.amount,
        utr: request.utr,
        status: request.status,
        buyer: { name: request.buyerName, phone: request.buyerPhone, email: request.buyerEmail, instagram: request.buyerInstagram, gameUid: request.buyerGameUid, notes: request.buyerNotes },
        createdAt: request.createdAt,
        updatedAt: request.updatedAt
    });
});

function sendJson(response, statusCode, payload) {
    response.writeHead(statusCode, {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json; charset=utf-8',
        'X-Content-Type-Options': 'nosniff'
    });
    response.end(JSON.stringify(payload));
}

function isAdminAuthorized(request) {
    const match = /^Bearer ([a-f0-9]{64})$/i.exec(request.headers.authorization || '');
    if (!match) return false;
    const expiresAt = adminSessions.get(match[1]);
    if (!expiresAt || expiresAt <= Date.now()) {
        adminSessions.delete(match[1]);
        return false;
    }
    return true;
}

async function handleAdminLogin(request, response) {
    const origin = request.headers.origin;
    if (origin && new URL(origin).host !== request.headers.host) {
        sendJson(response, 403, { message: 'Request origin is not allowed.' });
        return;
    }
    const address = request.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const attempts = failedAdminLogins.get(address);
    if (attempts && attempts.count >= 5 && attempts.resetAt > now) {
        sendJson(response, 429, { message: 'Too many failed attempts. Please wait 15 minutes.' });
        return;
    }
    let body;
    try { body = await readJson(request); }
    catch {
        sendJson(response, 400, { message: 'Invalid login request.' });
        return;
    }
    const supplied = Buffer.from(body && typeof body.password === 'string' ? body.password : '');
    const expected = Buffer.from(ADMIN_PASSWORD);
    const valid = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
    if (!valid) {
        const nextAttempts = attempts && attempts.resetAt > now ? attempts : { count: 0, resetAt: now + 15 * 60 * 1000 };
        nextAttempts.count += 1;
        failedAdminLogins.set(address, nextAttempts);
        sendJson(response, 401, { message: 'Incorrect passcode.' });
        return;
    }
    failedAdminLogins.delete(address);
    const token = crypto.randomBytes(32).toString('hex');
    adminSessions.set(token, now + 60 * 60 * 1000);
    sendJson(response, 200, { token, expiresIn: 3600 });
}

function persistTransaction(write) {
    database.exec('BEGIN IMMEDIATE');
    try {
        write();
        database.exec('COMMIT');
    } catch (error) {
        database.exec('ROLLBACK');
        throw error;
    }
}

function saveOrders() {
    const insert = database.prepare('INSERT INTO orders (order_id, listing_id, title, amount, status, utr, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    persistTransaction(() => {
        database.exec('DELETE FROM orders');
        orders.forEach(order => insert.run(order.orderId, order.listingId, order.title, order.amount, order.status, order.utr || null, order.createdAt, order.updatedAt));
    });
}

function saveAccounts() {
    const insert = database.prepare('INSERT INTO accounts (id, title, level, rank, price, category, status, tag) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    persistTransaction(() => {
        database.exec('DELETE FROM accounts');
        accounts.forEach(account => insert.run(account.id, account.title, account.level, account.rank, account.price, account.category, account.status, account.tag));
    });
}

function saveServiceRequests() {
    const insert = database.prepare('INSERT INTO service_requests (request_id, service_key, service_name, amount, utr, status, buyer_name, buyer_phone, buyer_email, buyer_instagram, buyer_game_uid, buyer_notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    persistTransaction(() => {
        database.exec('DELETE FROM service_requests');
        serviceRequests.forEach(request => insert.run(request.requestId, request.serviceKey, request.serviceName, request.amount, request.utr || null, request.status, request.buyer.name, request.buyer.phone, request.buyer.email, request.buyer.instagram, request.buyer.gameUid || '', request.buyer.notes || '', request.createdAt, request.updatedAt));
    });
}

function toPublicOrder(order, includeAdminFields = false) {
    const result = {
        orderId: order.orderId,
        title: order.title,
        amount: order.amount,
        status: order.status,
        createdAt: order.createdAt,
        updatedAt: order.updatedAt
    };
    if (includeAdminFields) {
        result.listingId = order.listingId;
        result.utr = order.utr || '';
    }
    return result;
}

function readJson(request) {
    return new Promise((resolve, reject) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', chunk => {
            body += chunk;
            if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
                reject(new Error('Request body too large'));
                request.destroy();
            }
        });
        request.on('end', () => {
            try { resolve(JSON.parse(body)); }
            catch { reject(new Error('Invalid JSON')); }
        });
        request.on('error', reject);
    });
}

function cleanText(value, maxLength) {
    return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, maxLength) : '';
}

const SERVICE_TYPES = {
    source_file_bind: { name: 'Source file bind', amount: 1000 },
    single_unsubscribe: { name: 'Single unsubscribe', amount: null },
    double_unsubscribe: { name: 'Double security / unsubscribe', amount: 2000 },
    sell_my_id: { name: 'Sell my ID', amount: 100 },
    security_service: { name: 'Find security service', amount: null },
    contact_admin: { name: 'Contact admin', amount: 10 }
};

function toPublicServiceRequest(request) {
    const result = {
        requestId: request.requestId,
        serviceKey: request.serviceKey,
        serviceName: request.serviceName,
        amount: request.amount,
        status: request.status,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt
    };
    if (request.serviceKey === 'contact_admin' && request.status === 'verified' && adminContactNumber) {
        result.adminContactNumber = adminContactNumber;
    }
    return result;
}

function toAdminServiceRequest(request) {
    return {
        ...toPublicServiceRequest(request),
        utr: request.utr || '',
        buyer: request.buyer
    };
}

function validateServiceRequest(body) {
    const buyer = body && body.buyer ? body.buyer : {};
    const serviceKey = body && body.serviceKey;
    const service = SERVICE_TYPES[serviceKey];
    const amount = service ? service.amount : null;
    const paymentRequired = Number.isFinite(amount) && amount > 0;
    const details = {
        serviceKey,
        serviceName: service && service.name,
        amount,
        name: cleanText(buyer.name, 80),
        phone: cleanText(buyer.phone, 24),
        email: cleanText(buyer.email, 254),
        instagram: cleanText(buyer.instagram, 30).replace(/^@/, ''),
        gameUid: cleanText(buyer.gameUid, 40),
        notes: cleanText(buyer.notes, 1000),
        consent: Boolean(body && body.consent === true),
        utr: cleanText(body && body.utr, 32).toUpperCase()
    };
    const valid = service && details.consent && details.name.length >= 2 &&
        /^\+?[0-9][0-9\s().-]{5,18}[0-9]$/.test(details.phone) &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email) &&
        /^[A-Za-z0-9._]{1,30}$/.test(details.instagram) &&
        (!paymentRequired || /^[A-Z0-9-]{8,32}$/.test(details.utr));
    return valid ? details : null;
}

async function notifyServiceRequest(request) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return false;
    const message = [
        'OM STORE: new service request',
        `Request: ${request.requestId}`,
        `Service: ${request.serviceName}`,
        `Amount: ${Number.isFinite(request.amount) ? `INR ${request.amount.toFixed(2)}` : 'Price to be confirmed'}`,
        `Status: ${request.status}`,
        request.utr ? `UTR: ${request.utr}` : '',
        '',
        `Name: ${request.buyer.name}`,
        `Phone: ${request.buyer.phone}`,
        `Email: ${request.buyer.email}`,
        `Instagram: @${request.buyer.instagram}`,
        `Game UID: ${request.buyer.gameUid || 'Not provided'}`,
        `Request details: ${request.buyer.notes || 'Not provided'}`,
        '',
        Number(request.amount) > 0
            ? `Verify the ₹${request.amount} UPI payment before approving this request.`
            : 'Review this service request in the admin dashboard.'
    ].filter(Boolean).join('\n');
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message }),
        signal: AbortSignal.timeout(10000)
    });
    const result = await response.json().catch(() => null);
    return response.ok && result && result.ok === true;
}

async function handleCreateServiceRequest(request, response) {
    let body;
    try { body = await readJson(request); }
    catch {
        sendJson(response, 400, { message: 'Invalid service request.' });
        return;
    }
    const details = validateServiceRequest(body);
    if (!details) {
        sendJson(response, 400, { message: 'Check the service, contact details, and consent.' });
        return;
    }
    if (details.serviceKey === 'contact_admin' && !adminContactNumber) {
        sendJson(response, 503, { message: 'Admin contact is not configured yet. Please contact the store directly.' });
        return;
    }
    if (details.utr && ([...orders.values()].some(order => order.utr === details.utr) || [...serviceRequests.values()].some(item => item.utr === details.utr))) {
        sendJson(response, 409, { message: 'This UTR has already been submitted.' });
        return;
    }

    const now = new Date().toISOString();
    const requestId = `SV-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const serviceRequest = {
        requestId,
        serviceKey: details.serviceKey,
        serviceName: details.serviceName,
        amount: details.amount,
        utr: details.utr,
        status: Number(details.amount) > 0 ? 'payment_review' : 'submitted',
        buyer: {
            name: details.name,
            phone: details.phone,
            email: details.email,
            instagram: details.instagram,
            gameUid: details.gameUid,
            notes: details.notes
        },
        createdAt: now,
        updatedAt: now
    };
    serviceRequests.set(requestId, serviceRequest);
    try { saveServiceRequests(); }
    catch {
        serviceRequests.delete(requestId);
        sendJson(response, 500, { message: 'Could not save the service request.' });
        return;
    }

    let telegramSent = false;
    try { telegramSent = await notifyServiceRequest(serviceRequest); }
    catch { telegramSent = false; }
    sendJson(response, 201, { ...toPublicServiceRequest(serviceRequest), telegramSent });
}

async function handleServiceRequestStatus(response, requestId) {
    const serviceRequest = serviceRequests.get(requestId);
    if (!serviceRequest) {
        sendJson(response, 404, { message: 'Service request not found. Check the request number and try again.' });
        return;
    }
    sendJson(response, 200, toPublicServiceRequest(serviceRequest));
}

async function handleAdminServiceRequestStatus(request, response, requestId) {
    let body;
    try { body = await readJson(request); }
    catch {
        sendJson(response, 400, { message: 'Invalid service status update.' });
        return;
    }
    const serviceRequest = serviceRequests.get(requestId);
    const nextStatus = body && body.status;
    if (!serviceRequest) {
        sendJson(response, 404, { message: 'Service request not found.' });
        return;
    }
        const requiresPayment = Number(serviceRequest.amount) > 0;
        const allowed = requiresPayment
                ? (serviceRequest.status === 'payment_review' && ['verified', 'rejected'].includes(nextStatus)) ||
                    (serviceRequest.serviceKey !== 'contact_admin' && serviceRequest.status === 'verified' && nextStatus === 'completed')
                : (serviceRequest.status === 'submitted' && ['accepted', 'rejected'].includes(nextStatus)) ||
                    (serviceRequest.status === 'accepted' && nextStatus === 'completed');
    if (!allowed) {
        sendJson(response, 409, { message: 'This service request cannot move to that status.' });
        return;
    }
    serviceRequest.status = nextStatus;
    serviceRequest.updatedAt = new Date().toISOString();
    try {
        saveServiceRequests();
        sendJson(response, 200, toAdminServiceRequest(serviceRequest));
    } catch {
        sendJson(response, 500, { message: 'Could not save the service status.' });
    }
}

function validateSubmission(body) {
    const buyer = body && body.buyer ? body.buyer : {};
    const listing = body && body.listing ? body.listing : {};
    const details = {
        orderId: cleanText(body && body.orderId, 80),
        consent: Boolean(body && body.consent === true),
        name: cleanText(buyer.name, 80),
        phone: cleanText(buyer.phone, 24),
        email: cleanText(buyer.email, 254),
        instagram: cleanText(buyer.instagram, 30).replace(/^@/, ''),
        utr: cleanText(body && body.utr, 32).toUpperCase(),
        listingId: Number(listing.id),
        title: cleanText(listing.title, 100),
        amount: Number(listing.amount)
    };
    const valid = details.orderId && details.consent &&
        details.name.length >= 2 &&
        /^\+?[0-9][0-9\s().-]{5,18}[0-9]$/.test(details.phone) &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(details.email) &&
        /^[A-Za-z0-9._]{1,30}$/.test(details.instagram) &&
        /^[A-Z0-9-]{8,32}$/.test(details.utr) &&
        Number.isInteger(details.listingId) && details.listingId > 0 &&
        details.title.length >= 2 && Number.isFinite(details.amount) && details.amount > 0;
    return valid ? details : null;
}

async function submitToTelegram(details) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return false;

    const message = [
        'OM STORE: payment review requested',
        `Order: ${details.orderId}`,
        `Listing: ${details.title} (ID ${details.listingId})`,
        `Amount: INR ${details.amount.toFixed(2)}`,
        `UTR: ${details.utr}`,
        '',
        `Name: ${details.name}`,
        `Phone: ${details.phone}`,
        `Email: ${details.email}`,
        `Instagram: @${details.instagram}`,
        '',
        'Verify the payment in your UPI/bank account before fulfilling the order.',
        'After payment is verified, send the full account details within 1 hour.'
    ].join('\n');

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: message }),
        signal: AbortSignal.timeout(10000)
    });
    const result = await response.json().catch(() => null);
    return response.ok && result && result.ok === true;
}

async function handleCreateOrder(request, response) {
    let body;
    try { body = await readJson(request); }
    catch {
        sendJson(response, 400, { message: 'Invalid order request.' });
        return;
    }
    const listing = body && body.listing ? body.listing : {};
    const listingId = Number(listing.id);
    const account = accounts.find(item => Number(item.id) === listingId);
    if (!account || account.status !== 'available' ||
        cleanText(listing.title, 100) !== account.title || Number(listing.amount) !== Number(account.price)) {
        sendJson(response, 400, { message: 'Invalid listing details.' });
        return;
    }

    const orderId = `OM-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const now = new Date().toISOString();
    const order = { orderId, listingId, title: account.title, amount: Number(account.price), status: 'awaiting_payment', createdAt: now, updatedAt: now };
    orders.set(orderId, order);
    try {
        saveOrders();
        sendJson(response, 201, toPublicOrder(order));
    } catch {
        orders.delete(orderId);
        sendJson(response, 500, { message: 'Could not create the order. Please retry.' });
    }
}

async function handlePaymentSubmission(request, response) {
    const origin = request.headers.origin;
    if (origin && new URL(origin).host !== request.headers.host) {
        sendJson(response, 403, { message: 'Request origin is not allowed.' });
        return;
    }

    const address = request.socket.remoteAddress || 'unknown';
    const now = Date.now();
    if (now - (recentSubmissions.get(address) || 0) < RATE_LIMIT_MS) {
        sendJson(response, 429, { message: 'Please wait a few seconds before submitting again.' });
        return;
    }

    let body;
    try { body = await readJson(request); }
    catch (error) {
        if (!response.destroyed) sendJson(response, error.message === 'Request body too large' ? 413 : 400, { message: 'Invalid submission.' });
        return;
    }
    const details = validateSubmission(body);
    if (!details) {
        sendJson(response, 400, { message: 'Check the name, phone, email, Instagram username, UTR, and listing details.' });
        return;
    }
    const order = orders.get(details.orderId);
    if (!order || order.status !== 'awaiting_payment') {
        sendJson(response, 409, { message: 'Order not found or it is no longer awaiting payment.' });
        return;
    }
    if (order.listingId !== details.listingId || order.title !== details.title || order.amount !== details.amount) {
        sendJson(response, 400, { message: 'Order details do not match.' });
        return;
    }
    if ([...orders.values()].some(item => item.orderId !== order.orderId && item.utr === details.utr)) {
        sendJson(response, 409, { message: 'This UTR has already been submitted.' });
        return;
    }
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
        sendJson(response, 503, { message: 'Telegram is not configured. Contact the store directly.' });
        return;
    }

    recentSubmissions.set(address, now);
    try {
        const sent = await submitToTelegram(details);
        if (!sent) {
            sendJson(response, 502, { message: 'Telegram could not accept the request. Please retry or contact the store.' });
            return;
        }
        order.status = 'payment_review';
        order.utr = details.utr;
        order.updatedAt = new Date().toISOString();
        const account = accounts.find(item => Number(item.id) === order.listingId);
        if (account && account.status === 'available') account.status = 'pending';
        saveOrders();
        saveAccounts();
        sendJson(response, 200, toPublicOrder(order));
    } catch {
        sendJson(response, 502, { message: 'Telegram could not be reached. Please retry or contact the store.' });
    }
}

function normalizeAccount(body, id) {
    const category = body && body.category;
    const status = body && body.status;
    const account = {
        id,
        title: cleanText(body && body.title, 80),
        level: Number(body && body.level),
        rank: cleanText(body && body.rank, 40),
        price: Number(body && body.price),
        category,
        status,
        tag: category === 'legend' ? 'Legendary' : category === 'rare' ? 'Rare' : 'Starter'
    };
    if (account.title.length < 2 || !Number.isInteger(account.level) || account.level < 1 || account.level > 100 ||
        account.rank.length < 2 || !Number.isFinite(account.price) || account.price < 0 ||
        !['legend', 'rare', 'starter'].includes(category) || !['available', 'pending', 'sold'].includes(status)) {
        return null;
    }
    return account;
}

async function handleSaveAccount(request, response, existingId = null) {
    let body;
    try { body = await readJson(request); }
    catch {
        sendJson(response, 400, { message: 'Invalid account data.' });
        return;
    }
    const id = existingId === null
        ? (accounts.length ? Math.max(...accounts.map(account => Number(account.id) || 0)) + 1 : 1)
        : existingId;
    const account = normalizeAccount(body, id);
    if (!account) {
        sendJson(response, 400, { message: 'Check the title, level, rank, price, category, and status.' });
        return;
    }
    const index = accounts.findIndex(item => Number(item.id) === id);
    if (existingId !== null && index === -1) {
        sendJson(response, 404, { message: 'Account not found.' });
        return;
    }
    if (index === -1) accounts.push(account);
    else accounts[index] = account;
    try {
        saveAccounts();
        sendJson(response, existingId === null ? 201 : 200, account);
    } catch {
        sendJson(response, 500, { message: 'Could not save the account.' });
    }
}

function handleDeleteAccount(response, id) {
    const accountIndex = accounts.findIndex(item => Number(item.id) === id);
    if (accountIndex === -1) {
        sendJson(response, 404, { message: 'Account not found.' });
        return;
    }
    if ([...orders.values()].some(order => order.listingId === id && ['awaiting_payment', 'payment_review'].includes(order.status))) {
        sendJson(response, 409, { message: 'This account has an active order and cannot be deleted yet.' });
        return;
    }
    const [deleted] = accounts.splice(accountIndex, 1);
    try {
        saveAccounts();
        sendJson(response, 200, { ok: true, id: deleted.id });
    } catch {
        accounts.splice(accountIndex, 0, deleted);
        sendJson(response, 500, { message: 'Could not delete the account.' });
    }
}

async function handleOrderStatus(request, response, orderId) {
    const order = orders.get(orderId);
    if (!order) {
        sendJson(response, 404, { message: 'Order not found. Check the order number and try again.' });
        return;
    }
    sendJson(response, 200, toPublicOrder(order));
}

async function handleAdminOrderStatus(request, response, orderId) {
    let body;
    try { body = await readJson(request); }
    catch {
        sendJson(response, 400, { message: 'Invalid status update.' });
        return;
    }
    const order = orders.get(orderId);
    const nextStatus = body && body.status;
    if (!order) {
        sendJson(response, 404, { message: 'Order not found.' });
        return;
    }
    if (order.status !== 'payment_review' || !['verified', 'rejected'].includes(nextStatus)) {
        sendJson(response, 409, { message: 'Only orders under payment review can be verified or rejected.' });
        return;
    }
    order.status = nextStatus;
    order.updatedAt = new Date().toISOString();
    const account = accounts.find(item => Number(item.id) === order.listingId);
    if (account) account.status = nextStatus === 'verified' ? 'sold' : 'available';
    try {
        saveOrders();
        saveAccounts();
        sendJson(response, 200, toPublicOrder(order, true));
    } catch {
        sendJson(response, 500, { message: 'Could not save the order status.' });
    }
}

const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname === '/api/admin/login' && request.method === 'POST') {
        await handleAdminLogin(request, response);
        return;
    }
    if (url.pathname === '/api/accounts' && request.method === 'GET') {
        sendJson(response, 200, accounts);
        return;
    }
    if (url.pathname === '/api/admin/accounts') {
        if (!isAdminAuthorized(request)) {
            sendJson(response, 401, { message: 'Admin login required.' });
            return;
        }
        if (request.method === 'GET') {
            sendJson(response, 200, accounts);
            return;
        }
        if (request.method === 'POST') {
            await handleSaveAccount(request, response);
            return;
        }
    }
    const accountMatch = url.pathname.match(/^\/api\/admin\/accounts\/(\d+)$/);
    if (accountMatch) {
        if (!isAdminAuthorized(request)) {
            sendJson(response, 401, { message: 'Admin login required.' });
            return;
        }
        const id = Number(accountMatch[1]);
        if (request.method === 'PUT') {
            await handleSaveAccount(request, response, id);
            return;
        }
        if (request.method === 'DELETE') {
            handleDeleteAccount(response, id);
            return;
        }
    }
    if (url.pathname === '/api/orders' && request.method === 'POST') {
        await handleCreateOrder(request, response);
        return;
    }
    if (url.pathname === '/api/service-requests' && request.method === 'POST') {
        await handleCreateServiceRequest(request, response);
        return;
    }
    if (url.pathname === '/api/admin/service-requests' && request.method === 'GET') {
        if (!isAdminAuthorized(request)) {
            sendJson(response, 401, { message: 'Admin login required.' });
            return;
        }
        sendJson(response, 200, [...serviceRequests.values()].map(toAdminServiceRequest).reverse());
        return;
    }
    if (url.pathname === '/api/submit-payment') {
        if (request.method !== 'POST') {
            sendJson(response, 405, { message: 'Method not allowed.' });
            return;
        }
        await handlePaymentSubmission(request, response);
        return;
    }
    const serviceRequestMatch = url.pathname.match(/^\/api\/service-requests\/([A-Z0-9-]+)$/i);
    if (serviceRequestMatch && request.method === 'GET') {
        await handleServiceRequestStatus(response, serviceRequestMatch[1]);
        return;
    }
    const adminServiceStatusMatch = url.pathname.match(/^\/api\/admin\/service-requests\/([A-Z0-9-]+)\/status$/i);
    if (adminServiceStatusMatch && request.method === 'POST') {
        if (!isAdminAuthorized(request)) {
            sendJson(response, 401, { message: 'Admin login required.' });
            return;
        }
        await handleAdminServiceRequestStatus(request, response, adminServiceStatusMatch[1]);
        return;
    }
    if (url.pathname === '/api/admin/orders' && request.method === 'GET') {
        if (!isAdminAuthorized(request)) {
            sendJson(response, 401, { message: 'Admin login required.' });
            return;
        }
        sendJson(response, 200, [...orders.values()].map(order => toPublicOrder(order, true)).reverse());
        return;
    }
    const orderStatusMatch = url.pathname.match(/^\/api\/orders\/([A-Z0-9-]+)$/i);
    if (orderStatusMatch && request.method === 'GET') {
        await handleOrderStatus(request, response, orderStatusMatch[1]);
        return;
    }
    const adminStatusMatch = url.pathname.match(/^\/api\/admin\/orders\/([A-Z0-9-]+)\/status$/i);
    if (adminStatusMatch && request.method === 'POST') {
        if (!isAdminAuthorized(request)) {
            sendJson(response, 401, { message: 'Admin login required.' });
            return;
        }
        await handleAdminOrderStatus(request, response, adminStatusMatch[1]);
        return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' });
        response.end('Method not allowed');
        return;
    }

    let pathname;
    try { pathname = decodeURIComponent(url.pathname); }
    catch {
        response.writeHead(400);
        response.end('Bad request');
        return;
    }
    const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
    const filePath = path.resolve(ROOT, relativePath);
    if (!filePath.startsWith(`${ROOT}${path.sep}`)) {
        response.writeHead(403);
        response.end('Forbidden');
        return;
    }
    const normalizedPath = relativePath.replace(/\\/g, '/').toLowerCase();
    if (normalizedPath === 'server.js' || normalizedPath === '.gitignore' || normalizedPath.startsWith('.env') ||
        normalizedPath === 'data' || normalizedPath.startsWith('data/')) {
        response.writeHead(404);
        response.end('Not found');
        return;
    }

    fs.readFile(filePath, (error, content) => {
        if (error) {
            response.writeHead(error.code === 'ENOENT' ? 404 : 500);
            response.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
            return;
        }
        response.writeHead(200, {
            'Cache-Control': 'no-cache',
            'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'strict-origin-when-cross-origin'
        });
        response.end(request.method === 'HEAD' ? undefined : content);
    });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`OM STORE running at http://localhost:${PORT}`);
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
        console.log('Telegram notifications are disabled until TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are configured.');
    }
});