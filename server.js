// ============================================================================
// ERP License Manager Server
// ============================================================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Redis } = require('@upstash/redis');

const app = express();
const PORT = process.env.LM_PORT || process.env.PORT || 4000;
const DB_FILE = path.join(__dirname, 'data.json');
const ADMIN_PASSWORD = process.env.LM_ADMIN_PASS || 'admin123';

// Initialize Upstash Redis if configured
const redis = (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) 
  ? new Redis({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN }) 
  : null;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Database helpers ────────────────────────────────────────────────────────
async function loadDB() {
  if (redis) {
    try {
      const db = await redis.get('erp_license_db');
      return db || { companies: [], licenses: [] };
    } catch (e) {
      console.error('Redis Load Error:', e);
      return { companies: [], licenses: [] };
    }
  }
  // Local fallback
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {}
  return { companies: [], licenses: [] };
}

async function saveDB(db) {
  if (redis) {
    await redis.set('erp_license_db', db);
  } else {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  }
}

function generateSerial() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const block = () => Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join('');
  return `CERP-${block()}-${block()}-${block()}-${block()}`;
}

function uid() { return crypto.randomUUID(); }

// ── Auth middleware ─────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${ADMIN_PASSWORD}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── Public: License Verification (called by ERP) ───────────────────────────
app.post('/api/verify', async (req, res) => {
  const { serialKey } = req.body;
  if (!serialKey) return res.json({ valid: false, message: 'No serial key provided' });

  const db = await loadDB();
  const license = db.licenses.find(l => l.serialKey === serialKey);
  if (!license) return res.json({ valid: false, message: 'Serial key not found' });

  const company = db.companies.find(c => c.id === license.companyId);
  const now = new Date();
  const expiry = new Date(license.expiryDate);

  license.lastCheckIn = now.toISOString();
  license.lastIP = req.headers['x-forwarded-for'] || req.ip || req.connection?.remoteAddress || 'unknown';
  await saveDB(db);

  if (license.status === 'revoked') {
    return res.json({ valid: false, message: 'License has been revoked. Contact the developer.', status: 'revoked' });
  }
  if (license.status === 'suspended') {
    return res.json({ valid: false, message: 'License has been suspended. Contact the developer.', status: 'suspended' });
  }
  if (expiry < now) {
    license.status = 'expired';
    await saveDB(db);
    return res.json({ valid: false, message: 'License has expired. Please renew.', status: 'expired' });
  }

  const daysLeft = Math.ceil((expiry - now) / (1000 * 60 * 60 * 24));
  return res.json({
    valid: true,
    status: 'active',
    company: company?.name || 'Unknown',
    expiryDate: license.expiryDate,
    daysLeft,
    maxUsers: license.maxUsers,
    plan: license.plan,
    message: daysLeft <= 7 ? `Warning: License expires in ${daysLeft} day(s)` : 'License is active',
  });
});

// ── Admin: Login ────────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    return res.json({ success: true, token: ADMIN_PASSWORD });
  }
  return res.status(401).json({ success: false, error: 'Wrong password' });
});

// ── Admin: Dashboard Stats ──────────────────────────────────────────────────
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const db = await loadDB();
  const now = new Date();
  const active = db.licenses.filter(l => l.status === 'active' && new Date(l.expiryDate) > now).length;
  const expired = db.licenses.filter(l => l.status === 'expired' || (l.status === 'active' && new Date(l.expiryDate) <= now)).length;
  const suspended = db.licenses.filter(l => l.status === 'suspended').length;
  const revoked = db.licenses.filter(l => l.status === 'revoked').length;
  res.json({
    totalCompanies: db.companies.length,
    totalLicenses: db.licenses.length,
    active, expired, suspended, revoked,
  });
});

// ── Admin: Companies CRUD ───────────────────────────────────────────────────
app.get('/api/admin/companies', requireAdmin, async (req, res) => {
  const db = await loadDB();
  const companies = db.companies.map(c => ({
    ...c,
    activeLicenses: db.licenses.filter(l => l.companyId === c.id && l.status === 'active').length,
    totalLicenses: db.licenses.filter(l => l.companyId === c.id).length,
  }));
  res.json(companies);
});

app.post('/api/admin/companies', requireAdmin, async (req, res) => {
  const { name, contactPerson, phone, email } = req.body;
  if (!name) return res.status(400).json({ error: 'Company name is required' });
  const db = await loadDB();
  const company = { id: uid(), name, contactPerson: contactPerson || '', phone: phone || '', email: email || '', createdAt: new Date().toISOString() };
  db.companies.push(company);
  await saveDB(db);
  res.json(company);
});

app.delete('/api/admin/companies/:id', requireAdmin, async (req, res) => {
  const db = await loadDB();
  db.companies = db.companies.filter(c => c.id !== req.params.id);
  db.licenses = db.licenses.filter(l => l.companyId !== req.params.id);
  await saveDB(db);
  res.json({ success: true });
});

// ── Admin: Licenses CRUD ────────────────────────────────────────────────────
app.get('/api/admin/licenses', requireAdmin, async (req, res) => {
  const db = await loadDB();
  let modified = false;
  const licenses = db.licenses.map(l => {
    const company = db.companies.find(c => c.id === l.companyId);
    const now = new Date();
    const expiry = new Date(l.expiryDate);
    if (l.status === 'active' && expiry < now) { l.status = 'expired'; modified = true; }
    return { ...l, companyName: company?.name || 'Deleted Company', daysLeft: Math.max(0, Math.ceil((expiry - now) / (1000*60*60*24))) };
  });
  if (modified) await saveDB(db);
  res.json(licenses);
});

app.post('/api/admin/licenses', requireAdmin, async (req, res) => {
  const { companyId, plan, durationDays, maxUsers } = req.body;
  if (!companyId || !durationDays) return res.status(400).json({ error: 'companyId and durationDays required' });
  const db = await loadDB();
  if (!db.companies.find(c => c.id === companyId)) return res.status(404).json({ error: 'Company not found' });

  const now = new Date();
  const expiry = new Date(now);
  expiry.setDate(expiry.getDate() + parseInt(durationDays));

  const license = {
    id: uid(),
    serialKey: generateSerial(),
    companyId,
    status: 'active',
    plan: plan || 'custom',
    startDate: now.toISOString(),
    expiryDate: expiry.toISOString(),
    maxUsers: parseInt(maxUsers) || 999,
    lastCheckIn: null,
    lastIP: null,
    createdAt: now.toISOString(),
  };
  db.licenses.push(license);
  await saveDB(db);
  res.json(license);
});

app.patch('/api/admin/licenses/:id/:action', requireAdmin, async (req, res) => {
  const { id, action } = req.params;
  const db = await loadDB();
  const l = db.licenses.find(x => x.id === id);
  if (!l) return res.status(404).json({ error: 'Not found' });
  
  if (action === 'suspend') l.status = 'suspended';
  else if (action === 'activate') l.status = 'active';
  else if (action === 'revoke') l.status = 'revoked';
  else if (action === 'renew') {
    const { durationDays } = req.body;
    if (!durationDays) return res.status(400).json({ error: 'durationDays required' });
    const now = new Date();
    const currentExpiry = new Date(l.expiryDate);
    const base = currentExpiry > now ? currentExpiry : now;
    base.setDate(base.getDate() + parseInt(durationDays));
    l.expiryDate = base.toISOString();
    l.status = 'active';
  } else return res.status(400).json({ error: 'Invalid action' });

  await saveDB(db);
  res.json(l);
});

app.delete('/api/admin/licenses/:id', requireAdmin, async (req, res) => {
  const db = await loadDB();
  db.licenses = db.licenses.filter(l => l.id !== req.params.id);
  await saveDB(db);
  res.json({ success: true });
});

// ── Vercel / Express Start ──────────────────────────────────────────────────
if (process.env.VERCEL) {
  // Export for Vercel Serverless
  module.exports = app;
} else {
  // Run local server
  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`\n╔══════════════════════════════════════════════╗`);
    console.log(`║   ERP License Manager running on port ${PORT}   ║`);
    console.log(`║   Dashboard: http://localhost:${PORT}            ║`);
    console.log(`║   Admin Password: ${ADMIN_PASSWORD}                  ║`);
    console.log(`║   Database: ${redis ? 'Upstash Redis (Cloud)' : 'Local data.json'}        ║`);
    console.log(`╚══════════════════════════════════════════════╝\n`);
    if (!redis && !fs.existsSync(DB_FILE)) await saveDB({ companies: [], licenses: [] });
  });
}
