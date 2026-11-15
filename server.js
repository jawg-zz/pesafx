const express = require('express');
const crypto = require('crypto');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// ---- M-Pesa Daraja config ----
const MPESA_ENV = (process.env.MPESA_ENV || '').toLowerCase(); // sandbox | production
const MPESA_CONSUMER_KEY = process.env.MPESA_CONSUMER_KEY || '';
const MPESA_CONSUMER_SECRET = process.env.MPESA_CONSUMER_SECRET || '';
const MPESA_SHORTCODE = process.env.MPESA_SHORTCODE || '';
const MPESA_PASSKEY = process.env.MPESA_PASSKEY || '';
const MPESA_TYPE = process.env.MPESA_TYPE || 'paybill'; // paybill | till
const PUBLIC_URL = process.env.PUBLIC_URL || '';

function darajaBase() {
  return MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';
}
function hasCreds() {
  return !!(MPESA_CONSUMER_KEY && MPESA_CONSUMER_SECRET && MPESA_SHORTCODE && MPESA_PASSKEY);
}
function demoMode() { return !hasCreds(); }

// ---- token cache ----
let tokenCache = { token: null, expires: 0 };
async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expires) return tokenCache.token;
  const base = darajaBase();
  const auth = Buffer.from(MPESA_CONSUMER_KEY + ':' + MPESA_CONSUMER_SECRET).toString('base64');
  const r = await fetch(base + '/oauth/v1/generate?grant_type=client_credentials', {
    headers: { Authorization: 'Basic ' + auth }
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('oauth_failed: ' + JSON.stringify(j));
  tokenCache = { token: j.access_token, expires: Date.now() + (j.expires_in - 60) * 1000 };
  return tokenCache.token;
}

function nairobiTimestamp() {
  // YYYYMMDDHHmmss in Africa/Nairobi
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }));
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + pad(d.getMonth()+1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

// ---- in-memory wallet store (demo) ----
const transactions = [];
let balance = 10000;

// ---- routes ----
app.get('/api/health', (req, res) => {
  res.json({ ok: true, demo: demoMode(), env: MPESA_ENV || 'unset' });
});

app.get('/api/wallet', (req, res) => {
  res.json({ balance, transactions });
});

app.post('/api/mpesa/stkpush', async (req, res) => {
  const { phone, amount } = req.body || {};
  if (!phone || !amount) return res.status(400).json({ error: 'phone and amount required' });
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'invalid amount' });

  // normalize phone to 254...
  let p = String(phone).replace(/\D/g, '');
  if (p.startsWith('0')) p = '254' + p.slice(1);
  if (p.startsWith('+')) p = p.slice(1);

  if (demoMode()) {
    const checkoutId = 'DEMO-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    const tx = { id: checkoutId, phone: p, amount: amt, status: 'pending', mode: 'demo', time: new Date().toISOString() };
    transactions.unshift(tx);
    return res.json({ ResponseCode: '0', CheckoutRequestID: checkoutId, CustomerMessage: 'Demo STK push (no Daraja creds).', demo: true });
  }

  try {
    const token = await getAccessToken();
    const ts = nairobiTimestamp();
    const password = Buffer.from(MPESA_SHORTCODE + MPESA_PASSKEY + ts).toString('base64');
    const txType = MPESA_TYPE === 'till' ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline';
    const partyB = MPESA_SHORTCODE;
    const callbackUrl = (PUBLIC_URL || ('http://localhost:' + PORT)) + '/api/mpesa/callback';
    const body = {
      BusinessShortCode: MPESA_SHORTCODE,
      Password: password,
      Timestamp: ts,
      TransactionType: txType,
      Amount: Math.round(amt),
      PartyA: p,
      PartyB: partyB,
      PhoneNumber: p,
      CallBackURL: callbackUrl,
      AccountReference: 'PesaFX',
      TransactionDesc: 'PesaFX deposit'
    };
    const r = await fetch(darajaBase() + '/mpesa/stkpush/v1/processrequest', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json();
    const tx = { id: j.CheckoutRequestID || ('ERR-' + Date.now()), phone: p, amount: amt, status: j.ResponseCode === '0' ? 'pending' : 'failed', mode: 'live', raw: j, time: new Date().toISOString() };
    transactions.unshift(tx);
    res.json(j);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post('/api/mpesa/callback', (req, res) => {
  try {
    const cb = (req.body && req.body.Body && req.body.Body.stkCallback) || {};
    const checkoutId = cb.CheckoutRequestID;
    const resultCode = cb.ResultCode;
    const tx = transactions.find(t => t.id === checkoutId);
    if (resultCode === 0) {
      const meta = cb.CallbackMetadata && cb.CallbackMetadata.Item || [];
      const get = (name) => { const it = meta.find(m => m.Name === name); return it ? it.Value : null; };
      const amount = get('Amount');
      if (tx) { tx.status = 'success'; tx.receipt = get('MpesaReceiptNumber'); tx.amount = amount || tx.amount; }
      if (amount) balance += Number(amount);
    } else {
      if (tx) { tx.status = 'failed'; tx.reason = cb.ResultDesc; }
    }
  } catch (e) { console.error('callback err', e); }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

app.post('/api/wallet/withdraw', (req, res) => {
  const { amount } = req.body || {};
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'invalid amount' });
  if (amt > balance) return res.status(400).json({ error: 'insufficient balance' });
  balance -= amt;
  const tx = { id: 'WD-' + Date.now(), amount: amt, status: 'success', type: 'withdrawal', time: new Date().toISOString() };
  transactions.unshift(tx);
  res.json({ ok: true, balance, tx });
});

app.listen(PORT, () => {
  console.log('PesaFX listening on ' + PORT + (demoMode() ? ' (M-Pesa DEMO mode)' : ' (M-Pesa LIVE)'));
});
