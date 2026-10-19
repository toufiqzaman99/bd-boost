'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { URL } = require('node:url');

/* --------------------------------------------------------------------------
   Environment
   -------------------------------------------------------------------------- */
function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SESSION_TTL_HOURS = Math.max(1, Math.min(72, Number(process.env.SESSION_TTL_HOURS) || 12));
const SESSION_TTL_MS = SESSION_TTL_HOURS * 60 * 60 * 1000;
const SESSION_COOKIE = 'tm_admin_session';
const CUSTOMER_SESSION_TTL_DAYS = Math.max(1, Math.min(365, Number(process.env.CUSTOMER_SESSION_TTL_DAYS) || 30));
const CUSTOMER_SESSION_TTL_MS = CUSTOMER_SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
const CUSTOMER_SESSION_COOKIE = 'tm_customer_session';
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const scryptAsync = promisify(crypto.scrypt);

if (ADMIN_PASSWORD.length < 12) {
  console.error('\n[FATAL] Set a strong ADMIN_PASSWORD (minimum 12 characters) in .env or the environment.\n');
  process.exit(1);
}

const ADMIN_PASSWORD_HASH = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();

/* --------------------------------------------------------------------------
   Catalogue — prices are controlled by the server, never trusted from client
   -------------------------------------------------------------------------- */
const PACKAGES = {
  'followers-1k': {
    price: 99,
    type: 'followers',
    name: { bn: '১K ফলোয়ার', en: '1K Followers' }
  },
  'followers-5k': {
    price: 450,
    type: 'followers',
    name: { bn: '৫K ফলোয়ার', en: '5K Followers' }
  },
  'followers-10k': {
    price: 880,
    type: 'followers',
    name: { bn: '১০K ফলোয়ার', en: '10K Followers' }
  },
  'views-100k': {
    price: 660,
    type: 'views',
    name: { bn: '১০০K ভিউ', en: '100K Views' }
  },
  'reactions-1k': {
    price: 250,
    type: 'reactions',
    name: { bn: '১K রিঅ্যাকশন', en: '1K Reactions' }
  },
  'comments-100': {
    price: 200,
    type: 'comments',
    name: { bn: '১০০ কমেন্ট', en: '100 Comments' }
  }
};

const VALID_REACTIONS = new Set(['like', 'love', 'care', 'haha', 'angry']);
const VALID_PAYMENTS = new Set(['bkash']);
const VALID_STATUSES = new Set(['new', 'processing', 'delivered', 'cancelled']);
const ALLOWED_FACEBOOK_HOSTS = new Set([
  'facebook.com', 'm.facebook.com', 'web.facebook.com', 'fb.com', 'm.fb.com', 'fb.watch'
]);

/* --------------------------------------------------------------------------
   Storage
   -------------------------------------------------------------------------- */
let orders = [];
let customers = [];
let writeQueue = Promise.resolve();
let customerWriteQueue = Promise.resolve();

async function atomicWrite(filePath, contents) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tempPath, contents, { encoding: 'utf8', mode: 0o600 });
  try {
    await fsp.rename(tempPath, filePath);
  } catch (error) {
    // Windows occasionally refuses overwrite-by-rename; fall back safely.
    if (error.code === 'EEXIST' || error.code === 'EPERM') {
      await fsp.copyFile(tempPath, filePath);
      await fsp.unlink(tempPath).catch(() => {});
    } else {
      await fsp.unlink(tempPath).catch(() => {});
      throw error;
    }
  }
}

function persistOrders() {
  const snapshot = JSON.stringify(orders, null, 2);
  const job = writeQueue
    .catch(() => {})
    .then(() => atomicWrite(ORDERS_FILE, snapshot));
  writeQueue = job;
  return job;
}

async function loadOrders() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fsp.readFile(ORDERS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('orders.json must contain an array');
    orders = parsed;
  } catch (error) {
    if (error.code === 'ENOENT') {
      orders = [];
      await persistOrders();
      return;
    }
    throw new Error(`Could not load orders from ${ORDERS_FILE}: ${error.message}`);
  }
}

function persistCustomers() {
  const snapshot = JSON.stringify(customers, null, 2);
  const job = customerWriteQueue
    .catch(() => {})
    .then(() => atomicWrite(CUSTOMERS_FILE, snapshot));
  customerWriteQueue = job;
  return job;
}

async function loadCustomers() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fsp.readFile(CUSTOMERS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('customers.json must contain an array');
    customers = parsed;
  } catch (error) {
    if (error.code === 'ENOENT') {
      customers = [];
      await persistCustomers();
      return;
    }
    throw new Error(`Could not load customers from ${CUSTOMERS_FILE}: ${error.message}`);
  }
}

/* --------------------------------------------------------------------------
   Sessions, rate limits, helpers
   -------------------------------------------------------------------------- */
const sessions = new Map();
const customerSessions = new Map();
const loginFailures = new Map();
const customerLoginFailures = new Map();
const customerSignupBuckets = new Map();
const orderRateBuckets = new Map();
const SESSION_CLEANUP = setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(token);
  }
  for (const [token, session] of customerSessions) {
    if (session.expiresAt <= now) customerSessions.delete(token);
  }
  for (const [ip, record] of loginFailures) {
    if (record.resetAt <= now) loginFailures.delete(ip);
  }
  for (const [key, record] of customerLoginFailures) {
    if (record.resetAt <= now) customerLoginFailures.delete(key);
  }
  for (const [ip, record] of customerSignupBuckets) {
    if (record.resetAt <= now) customerSignupBuckets.delete(ip);
  }
  for (const [ip, record] of orderRateBuckets) {
    if (record.resetAt <= now) orderRateBuckets.delete(ip);
  }
}, 10 * 60 * 1000);
SESSION_CLEANUP.unref();

function isSecureRequest(req) {
  if (req.socket.encrypted) return true;
  const forwarded = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return forwarded === 'https';
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

function parseCookies(header) {
  const result = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    result[key] = decodeURIComponent(value);
  }
  return result;
}

function getSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const expiresAt = sessions.get(token);
  if (!expiresAt) return null;
  if (expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, expiresAt };
}

function setSessionCookie(req, res, token) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`);
}

function clearSessionCookie(req, res) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0${secure}`);
}

function passwordMatches(input) {
  if (typeof input !== 'string') return false;
  const inputHash = crypto.createHash('sha256').update(input).digest();
  return crypto.timingSafeEqual(inputHash, ADMIN_PASSWORD_HASH);
}

const DUMMY_PASSWORD_SALT = crypto.randomBytes(16).toString('hex');
const DUMMY_PASSWORD_HASH = crypto.scryptSync(crypto.randomBytes(32).toString('hex'), DUMMY_PASSWORD_SALT, 64);

async function hashCustomerPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scryptAsync(password, salt, 64);
  return { salt, hash: Buffer.from(derived).toString('hex') };
}

async function verifyCustomerPassword(password, customer) {
  const salt = customer ? customer.passwordSalt : DUMMY_PASSWORD_SALT;
  const expected = customer ? Buffer.from(customer.passwordHash, 'hex') : DUMMY_PASSWORD_HASH;
  const derived = Buffer.from(await scryptAsync(password, salt, 64));
  if (!customer || derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function publicCustomer(customer) {
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    createdAt: customer.createdAt
  };
}

function getCustomerSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[CUSTOMER_SESSION_COOKIE];
  if (!token) return null;
  const session = customerSessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    customerSessions.delete(token);
    return null;
  }
  const customer = customers.find(item => item.id === session.customerId);
  if (!customer) {
    customerSessions.delete(token);
    return null;
  }
  return { token, customer, expiresAt: session.expiresAt };
}

function createCustomerSession(customerId) {
  const token = crypto.randomBytes(32).toString('base64url');
  customerSessions.set(token, {
    customerId,
    expiresAt: Date.now() + CUSTOMER_SESSION_TTL_MS
  });
  return token;
}

function setCustomerSessionCookie(req, res, token) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${CUSTOMER_SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(CUSTOMER_SESSION_TTL_MS / 1000)}${secure}`);
}

function clearCustomerSessionCookie(req, res) {
  const secure = isSecureRequest(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${CUSTOMER_SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`);
}

function checkCustomerSignupRate(ip) {
  const now = Date.now();
  let bucket = customerSignupBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + 60 * 60 * 1000 };
    customerSignupBuckets.set(ip, bucket);
  }
  if (bucket.count >= 10) return false;
  bucket.count += 1;
  return true;
}

function customerLoginKey(ip, phone) {
  return `${ip}|${phone}`;
}

function allowCustomerLoginAttempt(ip, phone) {
  const now = Date.now();
  const key = customerLoginKey(ip, phone);
  let record = customerLoginFailures.get(key);
  if (!record || record.resetAt <= now) {
    record = { count: 0, resetAt: now + 15 * 60 * 1000 };
    customerLoginFailures.set(key, record);
  }
  return record.count < 10;
}

function noteCustomerLoginFailure(ip, phone) {
  const record = customerLoginFailures.get(customerLoginKey(ip, phone));
  if (record) record.count += 1;
}

function clearCustomerLoginFailures(ip, phone) {
  customerLoginFailures.delete(customerLoginKey(ip, phone));
}

function checkLoginRate(ip) {
  const now = Date.now();
  let record = loginFailures.get(ip);
  if (!record || record.resetAt <= now) {
    record = { count: 0, resetAt: now + 15 * 60 * 1000 };
    loginFailures.set(ip, record);
  }
  return record.count < 8;
}

function noteLoginFailure(ip) {
  const record = loginFailures.get(ip);
  if (record) record.count += 1;
}

function allowOrderSubmission(ip) {
  const now = Date.now();
  let bucket = orderRateBuckets.get(ip);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + 10 * 60 * 1000 };
    orderRateBuckets.set(ip, bucket);
  }
  if (bucket.count >= 30) return false;
  bucket.count += 1;
  return true;
}

function createSession() {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

function setBaseSecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (isSecureRequest(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

function setHtmlHeaders(req, res) {
  setBaseSecurityHeaders(req, res);
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'"
  ].join('; '));
  res.setHeader('Cache-Control', 'no-store');
}

function sendJson(req, res, statusCode, payload, extraHeaders = {}) {
  setBaseSecurityHeaders(req, res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
  const body = JSON.stringify(payload);
  res.writeHead(statusCode);
  res.end(body);
}

function sendHtml(req, res, filePath, statusCode = 200) {
  let html;
  try {
    html = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    console.error(`[server] Could not read ${filePath}:`, error.message);
    sendJson(req, res, 500, { error: 'Page unavailable' });
    return;
  }
  setHtmlHeaders(req, res);
  if (filePath.endsWith('admin.html') || filePath.endsWith('account.html')) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  }
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function apiError(res, statusCode, message, req = null, extraHeaders = {}) {
  if (req) return sendJson(req, res, statusCode, { error: message }, extraHeaders);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: message }));
}

function readJson(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers['content-type'] || '').toLowerCase();
    if (!contentType.startsWith('application/json')) {
      const error = new Error('Content-Type must be application/json');
      error.statusCode = 415;
      reject(error);
      return;
    }
    let raw = '';
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        raw = '';
        const error = new Error('Request body is too large');
        error.statusCode = 413;
        reject(error);
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (tooLarge) return;
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Expected a JSON object');
        }
        resolve(parsed);
      } catch (error) {
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function cleanText(value, maxLength) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}

function normalisePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('880') && digits.length === 13) digits = `0${digits.slice(3)}`;
  else if (digits.startsWith('1') && digits.length === 10) digits = `0${digits}`;
  return digits;
}

function normaliseFacebookUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 500) return null;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (!ALLOWED_FACEBOOK_HOSTS.has(host)) return null;
  if (url.pathname.length <= 1) return null;
  return url.toString();
}

function createOrderId() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const datePart = `${map.year}${map.month}${map.day}`;
  let id;
  do {
    id = `TM-${datePart}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  } while (orders.some(order => order.id === id));
  return id;
}

function validateOrderPayload(body) {
  if (typeof body.name !== 'string' || typeof body.phone !== 'string' ||
      typeof body.facebookLink !== 'string' || typeof body.packageId !== 'string' ||
      typeof body.paymentMethod !== 'string' || typeof body.transactionId !== 'string') {
    return { error: 'Missing or invalid order fields' };
  }

  const name = body.name.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (name.length < 2) return { error: 'Invalid name' };

  const phone = normalisePhone(body.phone);
  if (!/^01[3-9]\d{8}$/.test(phone)) return { error: 'Invalid phone number' };

  const facebookLink = normaliseFacebookUrl(body.facebookLink);
  if (!facebookLink) return { error: 'Invalid Facebook page or post link' };

  const packageInfo = PACKAGES[body.packageId];
  if (!packageInfo) return { error: 'Invalid package' };

  if (!VALID_PAYMENTS.has(body.paymentMethod)) return { error: 'Invalid payment method' };

  const transactionId = String(body.transactionId).trim().toUpperCase();
  if (!/^[A-Z0-9]{6,30}$/.test(transactionId)) return { error: 'Invalid transaction ID' };

  const reaction = packageInfo.type === 'reactions'
    ? (VALID_REACTIONS.has(body.reaction) ? body.reaction : 'like')
    : null;

  const comments = packageInfo.type === 'comments'
    ? cleanText(body.comments, 600)
    : '';

  const now = new Date().toISOString();
  return {
    order: {
      id: createOrderId(),
      createdAt: now,
      updatedAt: now,
      status: 'new',
      statusHistory: [{ status: 'new', at: now }],
      name,
      phone,
      facebookLink,
      packageId: body.packageId,
      packageName: packageInfo.name,
      packageType: packageInfo.type,
      price: packageInfo.price,
      reaction,
      comments,
      paymentMethod: body.paymentMethod,
      transactionId,
      source: 'website',
      customerId: null
    }
  };
}

function adminOrdersResponse() {
  return orders.slice().sort((a, b) => {
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
}

function customerOrdersResponse(customerId) {
  return orders
    .filter(order => order.customerId === customerId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/* --------------------------------------------------------------------------
   Request routing
   -------------------------------------------------------------------------- */
async function handleRequest(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname;

  if (pathname === '/favicon.ico') {
    setBaseSecurityHeaders(req, res);
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname === '/health' && req.method === 'GET') {
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    sendHtml(req, res, path.join(ROOT, 'index.html'));
    return;
  }

  if (req.method === 'GET' && (pathname === '/admin' || pathname === '/admin/')) {
    sendHtml(req, res, path.join(ROOT, 'admin.html'));
    return;
  }

  if (req.method === 'GET' && (pathname === '/account' || pathname === '/account/')) {
    sendHtml(req, res, path.join(ROOT, 'account.html'));
    return;
  }

  if (pathname === '/api/orders') {
    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
      return;
    }
    if (!allowOrderSubmission(clientIp(req))) {
      sendJson(req, res, 429, { error: 'Too many orders. Please try again later.' }, { 'Retry-After': '600' });
      return;
    }
    try {
      const body = await readJson(req);
      const validated = validateOrderPayload(body);
      if (validated.error) {
        sendJson(req, res, 400, { error: validated.error });
        return;
      }
      const customerSession = getCustomerSession(req);
      if (customerSession) validated.order.customerId = customerSession.customer.id;
      orders.push(validated.order);
      try {
        await persistOrders();
      } catch (error) {
        orders = orders.filter(order => order.id !== validated.order.id);
        console.error('[orders] Failed to persist a new order:', error.message);
        sendJson(req, res, 500, { error: 'Could not save the order' });
        return;
      }
      console.log(`[order] ${validated.order.id} · ${validated.order.packageId} · ৳${validated.order.price}`);
      sendJson(req, res, 201, { ok: true, id: validated.order.id });
      return;
    } catch (error) {
      sendJson(req, res, error.statusCode || 400, { error: error.statusCode ? error.message : 'Could not process order' });
      return;
    }
  }

  if (pathname === '/api/customer/signup') {
    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
      return;
    }
    if (!checkCustomerSignupRate(clientIp(req))) {
      sendJson(req, res, 429, { error: 'Too many accounts created. Try again later.', code: 'RATE_LIMITED' }, { 'Retry-After': '3600' });
      return;
    }
    try {
      const body = await readJson(req, 8 * 1024);
      if (typeof body.name !== 'string' || typeof body.phone !== 'string' || typeof body.password !== 'string') {
        sendJson(req, res, 400, { error: 'Name, phone and password are required.', code: 'INVALID_INPUT' });
        return;
      }
      const name = cleanText(body.name, 60).replace(/\s+/g, ' ');
      if (name.length < 2) {
        sendJson(req, res, 400, { error: 'Invalid name.', code: 'INVALID_NAME' });
        return;
      }
      const phone = normalisePhone(body.phone);
      if (!/^01[3-9]\d{8}$/.test(phone)) {
        sendJson(req, res, 400, { error: 'Invalid phone number.', code: 'INVALID_PHONE' });
        return;
      }
      if (body.password.length < 8 || body.password.length > 128) {
        sendJson(req, res, 400, { error: 'Password must be 8–128 characters.', code: 'INVALID_PASSWORD' });
        return;
      }
      if (customers.some(customer => customer.phone === phone)) {
        sendJson(req, res, 409, { error: 'An account already exists for this phone number.', code: 'PHONE_EXISTS' });
        return;
      }
      const passwordRecord = await hashCustomerPassword(body.password);
      // Re-check after the async hash to avoid two simultaneous registrations.
      if (customers.some(customer => customer.phone === phone)) {
        sendJson(req, res, 409, { error: 'An account already exists for this phone number.', code: 'PHONE_EXISTS' });
        return;
      }
      const now = new Date().toISOString();
      const customer = {
        id: crypto.randomUUID(),
        name,
        phone,
        passwordSalt: passwordRecord.salt,
        passwordHash: passwordRecord.hash,
        createdAt: now,
        updatedAt: now
      };
      customers.push(customer);
      try {
        await persistCustomers();
      } catch (error) {
        customers = customers.filter(item => item.id !== customer.id);
        console.error('[customers] Could not save a new account:', error.message);
        sendJson(req, res, 500, { error: 'Could not create account.', code: 'SERVER_ERROR' });
        return;
      }
      const token = createCustomerSession(customer.id);
      setCustomerSessionCookie(req, res, token);
      sendJson(req, res, 201, { customer: publicCustomer(customer) });
      return;
    } catch (error) {
      sendJson(req, res, error.statusCode || 400, {
        error: error.statusCode === 413 ? 'Request is too large.' : 'Could not create account.',
        code: 'INVALID_INPUT'
      });
      return;
    }
  }

  if (pathname === '/api/customer/login') {
    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
      return;
    }
    try {
      const body = await readJson(req, 8 * 1024);
      if (typeof body.phone !== 'string' || typeof body.password !== 'string') {
        sendJson(req, res, 400, { error: 'Phone and password are required.', code: 'INVALID_INPUT' });
        return;
      }
      const phone = normalisePhone(body.phone);
      const ip = clientIp(req);
      if (!/^01[3-9]\d{8}$/.test(phone)) {
        sendJson(req, res, 400, { error: 'Invalid phone number.', code: 'INVALID_PHONE' });
        return;
      }
      if (!allowCustomerLoginAttempt(ip, phone)) {
        sendJson(req, res, 429, { error: 'Too many attempts. Try again in 15 minutes.', code: 'RATE_LIMITED' }, { 'Retry-After': '900' });
        return;
      }
      const customer = customers.find(item => item.phone === phone);
      const valid = await verifyCustomerPassword(body.password, customer || null);
      if (!valid) {
        noteCustomerLoginFailure(ip, phone);
        sendJson(req, res, 401, { error: 'Phone or password is incorrect.', code: 'INVALID_CREDENTIALS' });
        return;
      }
      clearCustomerLoginFailures(ip, phone);
      const token = createCustomerSession(customer.id);
      setCustomerSessionCookie(req, res, token);
      sendJson(req, res, 200, { customer: publicCustomer(customer) });
      return;
    } catch (error) {
      sendJson(req, res, error.statusCode || 400, { error: 'Could not sign in.', code: 'INVALID_INPUT' });
      return;
    }
  }

  if (pathname === '/api/customer/logout') {
    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
      return;
    }
    const session = getCustomerSession(req);
    if (session) customerSessions.delete(session.token);
    clearCustomerSessionCookie(req, res);
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/customer/me') {
    if (req.method !== 'GET') {
      sendJson(req, res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
      return;
    }
    const session = getCustomerSession(req);
    if (!session) {
      sendJson(req, res, 200, { authenticated: false, customer: null });
      return;
    }
    sendJson(req, res, 200, { authenticated: true, customer: publicCustomer(session.customer) });
    return;
  }

  if (pathname === '/api/customer/orders') {
    if (req.method !== 'GET') {
      sendJson(req, res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
      return;
    }
    const session = getCustomerSession(req);
    if (!session) {
      sendJson(req, res, 401, { error: 'Authentication required.', code: 'AUTH_REQUIRED' });
      return;
    }
    sendJson(req, res, 200, { orders: customerOrdersResponse(session.customer.id) });
    return;
  }

  if (pathname === '/api/admin/login') {
    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
      return;
    }
    const ip = clientIp(req);
    if (!checkLoginRate(ip)) {
      sendJson(req, res, 429, { error: 'Too many attempts. Try again in 15 minutes.' }, { 'Retry-After': '900' });
      return;
    }
    try {
      const body = await readJson(req);
      if (!passwordMatches(body.password)) {
        noteLoginFailure(ip);
        sendJson(req, res, 401, { error: 'Incorrect password.' });
        return;
      }
      loginFailures.delete(ip);
      const token = createSession();
      setSessionCookie(req, res, token);
      sendJson(req, res, 200, { ok: true });
      return;
    } catch (error) {
      sendJson(req, res, error.statusCode || 400, { error: 'Could not sign in.' });
      return;
    }
  }

  if (pathname === '/api/admin/logout') {
    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: 'Method not allowed' }, { Allow: 'POST' });
      return;
    }
    const session = getSession(req);
    if (session) sessions.delete(session.token);
    clearSessionCookie(req, res);
    sendJson(req, res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/admin/orders') {
    if (req.method !== 'GET') {
      sendJson(req, res, 405, { error: 'Method not allowed' }, { Allow: 'GET' });
      return;
    }
    if (!getSession(req)) {
      sendJson(req, res, 401, { error: 'Authentication required.' });
      return;
    }
    sendJson(req, res, 200, { orders: adminOrdersResponse() });
    return;
  }

  const statusMatch = pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
  if (statusMatch) {
    if (req.method !== 'PATCH') {
      sendJson(req, res, 405, { error: 'Method not allowed' }, { Allow: 'PATCH' });
      return;
    }
    if (!getSession(req)) {
      sendJson(req, res, 401, { error: 'Authentication required.' });
      return;
    }
    let orderId;
    try {
      orderId = decodeURIComponent(statusMatch[1]);
    } catch {
      sendJson(req, res, 400, { error: 'Invalid order id' });
      return;
    }
    try {
      const body = await readJson(req, 8 * 1024);
      if (!VALID_STATUSES.has(body.status)) {
        sendJson(req, res, 400, { error: 'Invalid status' });
        return;
      }
      const order = orders.find(item => item.id === orderId);
      if (!order) {
        sendJson(req, res, 404, { error: 'Order not found' });
        return;
      }
      if (order.status === body.status) {
        sendJson(req, res, 200, { ok: true, order });
        return;
      }
      const previousStatus = order.status;
      const previousUpdatedAt = order.updatedAt;
      const previousHistory = Array.isArray(order.statusHistory)
        ? JSON.parse(JSON.stringify(order.statusHistory))
        : null;
      const updatedAt = new Date().toISOString();
      if (!Array.isArray(order.statusHistory)) {
        order.statusHistory = [{ status: previousStatus, at: order.createdAt }];
      }
      order.status = body.status;
      order.updatedAt = updatedAt;
      order.statusHistory.push({ status: body.status, at: updatedAt });
      try {
        await persistOrders();
      } catch (error) {
        order.status = previousStatus;
        order.updatedAt = previousUpdatedAt;
        if (previousHistory === null) delete order.statusHistory;
        else order.statusHistory = previousHistory;
        console.error('[admin] Could not save status update:', error.message);
        sendJson(req, res, 500, { error: 'Could not update order' });
        return;
      }
      sendJson(req, res, 200, { ok: true, order });
      return;
    } catch (error) {
      sendJson(req, res, error.statusCode || 400, { error: 'Could not update order' });
      return;
    }
  }

  sendJson(req, res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error('[server] Unhandled request error:', error);
    if (!res.headersSent) {
      sendJson(req, res, 500, { error: 'Internal server error' });
    } else if (!res.writableEnded) {
      res.end();
    }
  });
});

server.requestTimeout = 15000;
server.headersTimeout = 10000;

async function start() {
  try {
    await Promise.all([loadOrders(), loadCustomers()]);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  server.listen(PORT, HOST, () => {
    console.log('');
    console.log('  ⚡ Thunder Maxit server is running');
    console.log(`     Website:   http://localhost:${PORT}`);
    console.log(`     Account:   http://localhost:${PORT}/account`);
    console.log(`     Admin:     http://localhost:${PORT}/admin`);
    console.log(`     Orders:    ${ORDERS_FILE}`);
    console.log(`     Customers: ${CUSTOMERS_FILE}`);
    console.log(`     Admin session: ${SESSION_TTL_HOURS}h · Customer session: ${CUSTOMER_SESSION_TTL_DAYS} days`);
    console.log('');
    console.log('     Use HTTPS in production. Change the password in .env, then restart.');
    console.log('');
  });
}

function shutdown(signal) {
  console.log(`\n[server] ${signal} received, shutting down...`);
  server.close(() => {
    Promise.allSettled([writeQueue, customerWriteQueue]).finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

start();
