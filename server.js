const express = require('express');
const { Pool } = require('pg');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'aquabike-secret-change-in-prod-' + crypto.randomBytes(16).toString('hex');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

// ─── Middleware ──────────────────────────────────────────
app.use(compression());
app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());

// Healthcheck Render — must stay before the SPA fallback
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true, db: true });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: e.message });
  }
});
app.use(express.static(path.join(__dirname, 'public')));

// ─── Config ─────────────────────────────────────────────
const CONFIG = {
  MAX_CAPACITY: 8,
  CANCEL_HOURS: 2,
  ADMIN_CODE: process.env.ADMIN_CODE || 'admin2026',
  ADMIN_PHONE: process.env.ADMIN_PHONE || '',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
  WAVE_API_KEY: process.env.WAVE_API_KEY || '',
  WAVE_API_URL: 'https://api.wave.com/v1/checkout/sessions',
  OM_MERCHANT_KEY: process.env.OM_MERCHANT_KEY || '',
  CURRENCY: 'XOF',
  APP_URL: process.env.APP_URL || `http://localhost:${PORT}`,
};

// ─── Subscription Plans ─────────────────────────────────
const PLANS = [
  { id:'mensuel_3x', name:'Mensuel 3x/semaine', desc:'Aquabike & Aquagym — 3 séances/semaine', price:65000, activities:['Aquabike','Aquagym'], limit_type:'weekly', limit_value:3, duration_days:30 },
  { id:'mensuel_5x', name:'Mensuel 5x/semaine', desc:'Aquabike & Aquagym — 5 séances/semaine', price:80000, activities:['Aquabike','Aquagym'], limit_type:'weekly', limit_value:5, duration_days:30 },
  { id:'carte_10', name:'Carte 10 séances', desc:'Aquabike & Aquagym — 10 séances sur 3 mois', price:75000, activities:['Aquabike','Aquagym'], limit_type:'total', limit_value:10, duration_days:90 },
  { id:'reeduc_10', name:'Rééducation 10 séances', desc:'Rééducation aquatique — 10 séances', price:200000, activities:['Rééducation'], limit_type:'total', limit_value:10, duration_days:180 },
  { id:'natation_10', name:'Natation 10 séances', desc:'Carnet de 10 séances de natation', price:80000, activities:['Natation'], limit_type:'total', limit_value:10, duration_days:180 },
  { id:'test', name:'Séance test', desc:'Découverte — 1 séance d\'essai', price:10000, activities:['Aquabike','Aquagym','Rééducation','Natation'], limit_type:'total', limit_value:1, duration_days:30 },
];

// ─── Schedule Rules ─────────────────────────────────────
function getActivityHours(activity, dayOfWeek) {
  const isWeekend = (dayOfWeek === 0 || dayOfWeek === 6);
  if (activity === 'Rééducation' || activity === 'Natation') {
    return [13, 14, 15, 16]; // 13h-17h every day
  }
  // Aquabike & Aquagym
  if (isWeekend) return [10, 11, 12]; // 10h-13h
  return [8, 9, 10, 11, 12, 17, 18, 19]; // 8h-13h + 17h-20h
}

// ─── SSE ────────────────────────────────────────────────
const sseClients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

// ─── Auth Middleware ─────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ ok: false, error: 'NO_TOKEN' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ ok: false, error: 'INVALID_TOKEN' }); }
}

// ─── Database Init ──────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(255) NOT NULL,
        phone VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(255),
        pin_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) DEFAULT 'client',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        plan_id VARCHAR(50) NOT NULL,
        plan_name VARCHAR(255) NOT NULL,
        activities TEXT[] NOT NULL,
        limit_type VARCHAR(20) NOT NULL,
        limit_value INTEGER NOT NULL,
        sessions_used INTEGER DEFAULT 0,
        price INTEGER NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        payment_method VARCHAR(50),
        payment_ref VARCHAR(255),
        starts_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS slots (
        id SERIAL PRIMARY KEY,
        date_slot DATE NOT NULL,
        hour_start SMALLINT NOT NULL,
        activity VARCHAR(128) NOT NULL,
        max_capacity SMALLINT DEFAULT 8,
        status SMALLINT DEFAULT 1,
        UNIQUE(date_slot, hour_start, activity)
      );
      CREATE TABLE IF NOT EXISTS bookings (
        id SERIAL PRIMARY KEY,
        slot_id INTEGER NOT NULL REFERENCES slots(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        subscription_id INTEGER REFERENCES subscriptions(id),
        status SMALLINT DEFAULT 1,
        booking_code VARCHAR(20) UNIQUE NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        cancelled_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_bookings_slot_active ON bookings(slot_id) WHERE status=1;
      CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);
      CREATE INDEX IF NOT EXISTS idx_slots_date ON slots(date_slot, hour_start);
      CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id) WHERE status='active';
    `);
    console.log('[DB] Tables ready');

    // Auto-create admin account if configured
    if (CONFIG.ADMIN_PHONE && CONFIG.ADMIN_PASSWORD) {
      const exists = await client.query('SELECT id FROM users WHERE phone=$1', [CONFIG.ADMIN_PHONE]);
      if (!exists.rows.length) {
        const hash = await bcrypt.hash(CONFIG.ADMIN_PASSWORD, 10);
        await client.query(
          "INSERT INTO users(full_name,phone,pin_hash,role) VALUES('Admin Aquabike',$1,$2,'admin')",
          [CONFIG.ADMIN_PHONE, hash]
        );
        console.log('[DB] Admin account created: ' + CONFIG.ADMIN_PHONE);
      } else {
        // Update to admin role + update password in case it changed
        const hash = await bcrypt.hash(CONFIG.ADMIN_PASSWORD, 10);
        await client.query("UPDATE users SET role='admin', pin_hash=$1 WHERE phone=$2", [hash, CONFIG.ADMIN_PHONE]);
        console.log('[DB] Admin account updated: ' + CONFIG.ADMIN_PHONE);
      }
    }
  } finally { client.release(); }
}

function genCode() { return 'AQ' + crypto.randomBytes(4).toString('hex').toUpperCase(); }

// ─── AUTH ROUTES ────────────────────────────────────────

// POST /api/register
app.post('/api/register', async (req, res) => {
  const { full_name, phone, email, pin } = req.body;
  if (!full_name || !phone || !pin || pin.length < 4) return res.status(400).json({ ok:false, error:'Nom, téléphone et mot de passe (4+ caractères) requis.' });
  try {
    const exists = await pool.query('SELECT id FROM users WHERE phone=$1', [phone]);
    if (exists.rows.length) return res.json({ ok:false, error:'Ce numéro est déjà inscrit.' });
    const hash = await bcrypt.hash(pin, 10);
    const r = await pool.query('INSERT INTO users(full_name,phone,email,pin_hash) VALUES($1,$2,$3,$4) RETURNING id,full_name,phone,role', [full_name.trim(), phone.trim(), email||null, hash]);
    const user = r.rows[0];
    const token = jwt.sign({ id:user.id, phone:user.phone, role:user.role }, JWT_SECRET, { expiresIn:'30d' });
    res.json({ ok:true, token, user });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/login
app.post('/api/login', async (req, res) => {
  const { phone, pin } = req.body;
  if (!phone || !pin) return res.status(400).json({ ok:false, error:'Téléphone et mot de passe requis.' });
  try {
    const r = await pool.query('SELECT id,full_name,phone,pin_hash,role FROM users WHERE phone=$1', [phone.trim()]);
    if (!r.rows.length) return res.json({ ok:false, error:'Compte non trouvé.' });
    const user = r.rows[0];
    const valid = await bcrypt.compare(pin, user.pin_hash);
    if (!valid) return res.json({ ok:false, error:'Mot de passe incorrect.' });
    const token = jwt.sign({ id:user.id, phone:user.phone, role:user.role }, JWT_SECRET, { expiresIn:'30d' });
    res.json({ ok:true, token, user:{ id:user.id, full_name:user.full_name, phone:user.phone, role:user.role } });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// GET /api/me — user profile
app.get('/api/me', auth, async (req, res) => {
  try {
    const r = await pool.query('SELECT id,full_name,phone,email,role,created_at FROM users WHERE id=$1', [req.user.id]);
    if (!r.rows.length) return res.json({ ok:false, error:'Utilisateur non trouvé.' });
    res.json({ ok:true, user:r.rows[0] });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/change-password
app.post('/api/change-password', auth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password || new_password.length < 4) {
    return res.status(400).json({ ok:false, error:'Mot de passe actuel et nouveau (4+ caractères) requis.' });
  }
  try {
    const r = await pool.query('SELECT pin_hash FROM users WHERE id=$1', [req.user.id]);
    if (!r.rows.length) return res.json({ ok:false, error:'Utilisateur non trouvé.' });
    const valid = await bcrypt.compare(current_password, r.rows[0].pin_hash);
    if (!valid) return res.json({ ok:false, error:'Mot de passe actuel incorrect.' });
    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET pin_hash=$1 WHERE id=$2', [hash, req.user.id]);
    res.json({ ok:true, message:'Mot de passe modifié avec succès.' });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/update-profile
app.post('/api/update-profile', auth, async (req, res) => {
  const { full_name, email } = req.body;
  try {
    await pool.query('UPDATE users SET full_name=COALESCE($1,full_name), email=COALESCE($2,email) WHERE id=$3',
      [full_name||null, email||null, req.user.id]);
    const r = await pool.query('SELECT id,full_name,phone,email,role FROM users WHERE id=$1', [req.user.id]);
    res.json({ ok:true, user:r.rows[0] });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ─── PLANS ──────────────────────────────────────────────
app.get('/api/plans', (req, res) => res.json({ ok:true, plans:PLANS }));

// ─── SUBSCRIPTIONS ──────────────────────────────────────

// GET /api/my-subscriptions
app.get('/api/my-subscriptions', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 ORDER BY created_at DESC`, [req.user.id]
    );
    res.json({ ok:true, subscriptions:r.rows });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/subscribe — initiate subscription + payment
app.post('/api/subscribe', auth, async (req, res) => {
  const { plan_id, payment_method } = req.body;
  const plan = PLANS.find(p => p.id === plan_id);
  if (!plan) return res.status(400).json({ ok:false, error:'Plan invalide.' });
  if (!['wave','orange_money','cash'].includes(payment_method)) return res.status(400).json({ ok:false, error:'Méthode de paiement invalide.' });

  try {
    const now = new Date();
    const expires = new Date(now.getTime() + plan.duration_days * 86400000);
    const payRef = 'PAY-' + genCode();

    const r = await pool.query(
      `INSERT INTO subscriptions(user_id,plan_id,plan_name,activities,limit_type,limit_value,price,payment_method,payment_ref,status,starts_at,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [req.user.id, plan.id, plan.name, plan.activities, plan.limit_type, plan.limit_value, plan.price, payment_method, payRef,
       payment_method === 'cash' ? 'pending' : 'pending', now, expires]
    );
    const subId = r.rows[0].id;

    let paymentUrl = null;

    if (payment_method === 'wave' && CONFIG.WAVE_API_KEY) {
      // Wave Checkout API
      try {
        const waveRes = await fetch(CONFIG.WAVE_API_URL, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${CONFIG.WAVE_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: plan.price,
            currency: CONFIG.CURRENCY,
            error_url: `${CONFIG.APP_URL}/#/payment-error`,
            success_url: `${CONFIG.APP_URL}/api/payment/callback?ref=${payRef}&provider=wave`,
            client_reference: payRef,
          })
        });
        const waveData = await waveRes.json();
        if (waveData.wave_launch_url) paymentUrl = waveData.wave_launch_url;
      } catch(e) { console.error('[Wave] Error:', e.message); }
    }

    if (payment_method === 'orange_money') {
      // Orange Money — generate a simple payment link or use their API
      // For now, generate a manual payment reference
      paymentUrl = `https://qrco.de/orange-money-sn?amount=${plan.price}&ref=${payRef}`;
    }

    if (payment_method === 'cash') {
      // Cash — admin validates manually
      paymentUrl = null;
    }

    // If no API key configured, simulate immediate activation for demo
    if (!CONFIG.WAVE_API_KEY && payment_method !== 'cash') {
      await pool.query('UPDATE subscriptions SET status=$1 WHERE id=$2', ['active', subId]);
    }

    res.json({ ok:true, subscription_id:subId, payment_url:paymentUrl, payment_ref:payRef });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// GET /api/payment/callback — Wave/OM payment confirmation
app.get('/api/payment/callback', async (req, res) => {
  const { ref, provider } = req.query;
  if (!ref) return res.redirect('/#/payment-error');
  try {
    await pool.query("UPDATE subscriptions SET status='active' WHERE payment_ref=$1 AND status='pending'", [ref]);
    res.redirect('/#/payment-success');
  } catch(e) { res.redirect('/#/payment-error'); }
});

// POST /api/payment/webhook — Wave webhook (server-to-server)
app.post('/api/payment/webhook', async (req, res) => {
  const { client_reference, payment_status } = req.body;
  if (payment_status === 'succeeded' && client_reference) {
    await pool.query("UPDATE subscriptions SET status='active' WHERE payment_ref=$1", [client_reference]);
  }
  res.json({ ok: true });
});

// POST /api/admin/validate-payment — admin validates cash payments
app.post('/api/admin/validate-payment', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok:false });
  const { subscription_id } = req.body;
  const now = new Date();
  // Get plan duration to set correct expiry
  const subRes = await pool.query('SELECT * FROM subscriptions WHERE id=$1', [subscription_id]);
  if (!subRes.rows.length) return res.json({ ok:false, error:'Abonnement non trouvé.' });
  const sub = subRes.rows[0];
  const plan = PLANS.find(p => p.id === sub.plan_id);
  const duration = plan ? plan.duration_days : 30;
  const expires = new Date(now.getTime() + duration * 86400000);
  await pool.query("UPDATE subscriptions SET status='active',starts_at=$1,expires_at=$2 WHERE id=$3", [now, expires, subscription_id]);
  broadcast('payment_validated', { subscription_id });
  res.json({ ok:true });
});

// GET /api/admin/dashboard — stats for admin
app.get('/api/admin/dashboard', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok:false });
  try {
    // Today's bookings by slot
    const today = new Date().toISOString().split('T')[0];
    const todayBookings = await pool.query(
      `SELECT TO_CHAR(s.date_slot, 'YYYY-MM-DD') AS date_slot, s.hour_start, s.activity, s.max_capacity,
        COUNT(b.id) FILTER(WHERE b.status=1) AS booked,
        (s.max_capacity - COUNT(b.id) FILTER(WHERE b.status=1)) AS remaining
       FROM slots s LEFT JOIN bookings b ON b.slot_id=s.id
       WHERE s.date_slot=$1 AND s.status=1
       GROUP BY s.id ORDER BY s.hour_start`, [today]
    );

    // Bookings for selected period with participant names
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 6);

    const weekBookings = await pool.query(
      `SELECT TO_CHAR(s.date_slot, 'YYYY-MM-DD') AS date_slot, s.hour_start, s.activity,
        b.id as booking_id, b.booking_code, b.status as booking_status, b.created_at,
        u.full_name, u.phone
       FROM bookings b
       JOIN slots s ON s.id=b.slot_id
       JOIN users u ON u.id=b.user_id
       WHERE s.date_slot>=$1 AND s.date_slot<=$2
       ORDER BY s.date_slot, s.hour_start, b.created_at`,
      [weekStart.toISOString().split('T')[0], weekEnd.toISOString().split('T')[0]]
    );

    // All subscriptions with user info
    const subscriptions = await pool.query(
      `SELECT sub.*, u.full_name, u.phone
       FROM subscriptions sub JOIN users u ON u.id=sub.user_id
       ORDER BY sub.created_at DESC LIMIT 50`
    );

    // Pending cash payments
    const pendingPayments = await pool.query(
      `SELECT sub.*, u.full_name, u.phone
       FROM subscriptions sub JOIN users u ON u.id=sub.user_id
       WHERE sub.status='pending' AND sub.payment_method='cash'
       ORDER BY sub.created_at DESC`
    );

    // Stats
    const totalUsers = await pool.query('SELECT COUNT(*) as nb FROM users');
    const totalActiveSubs = await pool.query("SELECT COUNT(*) as nb FROM subscriptions WHERE status='active'");
    const todayBookingsCount = await pool.query(
      `SELECT COUNT(*) as nb FROM bookings b JOIN slots s ON s.id=b.slot_id WHERE s.date_slot=$1 AND b.status=1`, [today]
    );

    res.json({
      ok: true,
      stats: {
        total_users: parseInt(totalUsers.rows[0].nb),
        active_subscriptions: parseInt(totalActiveSubs.rows[0].nb),
        today_bookings: parseInt(todayBookingsCount.rows[0].nb),
      },
      today_slots: todayBookings.rows,
      week_bookings: weekBookings.rows,
      subscriptions: subscriptions.rows,
      pending_payments: pendingPayments.rows,
    });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// GET /api/slot/:id/participants — who booked a specific slot
app.get('/api/slot/:id/participants', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT b.id, b.booking_code, b.status, b.created_at,
        u.full_name, u.phone
       FROM bookings b JOIN users u ON u.id=b.user_id
       WHERE b.slot_id=$1 ORDER BY b.created_at`,
      [req.params.id]
    );
    res.json({ ok:true, participants:r.rows });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// GET /api/admin/slots — list all slots with filters
app.get('/api/admin/slots', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok:false });
  const { start, end, activity } = req.query;
  const dateStart = start || new Date().toISOString().split('T')[0];
  const dateEnd = end || new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];
  try {
    let sql = `SELECT s.id, TO_CHAR(s.date_slot, 'YYYY-MM-DD') AS date_slot, s.hour_start, s.activity, s.max_capacity, s.status,
      COUNT(b.id) FILTER(WHERE b.status=1) AS booked
      FROM slots s LEFT JOIN bookings b ON b.slot_id=s.id
      WHERE s.date_slot>=$1 AND s.date_slot<=$2`;
    const params = [dateStart, dateEnd];
    if (activity) { sql += ' AND s.activity=$3'; params.push(activity); }
    sql += ' GROUP BY s.id ORDER BY s.date_slot, s.hour_start, s.activity';
    const r = await pool.query(sql, params);
    res.json({ ok:true, slots:r.rows });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// PUT /api/admin/slot/:id — update a slot
app.put('/api/admin/slot/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok:false });
  const { max_capacity, status, hour_start, activity } = req.body;
  try {
    const updates = [];
    const vals = [];
    let idx = 1;
    if (max_capacity !== undefined) { updates.push('max_capacity=$'+idx); vals.push(parseInt(max_capacity)); idx++; }
    if (status !== undefined) { updates.push('status=$'+idx); vals.push(parseInt(status)); idx++; }
    if (hour_start !== undefined) { updates.push('hour_start=$'+idx); vals.push(parseInt(hour_start)); idx++; }
    if (activity !== undefined) { updates.push('activity=$'+idx); vals.push(activity); idx++; }
    if (updates.length === 0) return res.json({ ok:false, error:'Rien à modifier' });
    vals.push(parseInt(req.params.id));
    await pool.query('UPDATE slots SET '+updates.join(',')+' WHERE id=$'+idx, vals);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// DELETE /api/admin/slot/:id — delete a slot (only if no active bookings)
app.delete('/api/admin/slot/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok:false });
  try {
    const check = await pool.query('SELECT COUNT(*) as nb FROM bookings WHERE slot_id=$1 AND status=1', [req.params.id]);
    if (parseInt(check.rows[0].nb) > 0) return res.json({ ok:false, error:'Impossible : des réservations actives existent.' });
    await pool.query('DELETE FROM bookings WHERE slot_id=$1', [req.params.id]);
    await pool.query('DELETE FROM slots WHERE id=$1', [req.params.id]);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// GET /api/admin/slots — list all slots with filters
app.get('/api/admin/slots', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok:false });
  const { start, end, activity } = req.query;
  try {
    let sql = `SELECT s.id, TO_CHAR(s.date_slot, 'YYYY-MM-DD') AS date_slot, s.hour_start, s.activity, s.max_capacity, s.status,
      COUNT(b.id) FILTER(WHERE b.status=1) AS booked
      FROM slots s LEFT JOIN bookings b ON b.slot_id=s.id
      WHERE 1=1`;
    const params = [];
    let idx = 1;
    if (start) { sql += ` AND s.date_slot >= $${idx++}`; params.push(start); }
    if (end) { sql += ` AND s.date_slot <= $${idx++}`; params.push(end); }
    if (activity) { sql += ` AND s.activity = $${idx++}`; params.push(activity); }
    sql += ` GROUP BY s.id ORDER BY s.date_slot DESC, s.hour_start ASC LIMIT 200`;
    const r = await pool.query(sql, params);
    res.json({ ok:true, slots:r.rows });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// PUT /api/admin/slots/:id — update a slot
app.put('/api/admin/slots/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok:false });
  const { max_capacity, activity, status, hour_start } = req.body;
  try {
    const fields = [];
    const params = [];
    let idx = 1;
    if (max_capacity !== undefined) { fields.push(`max_capacity=$${idx++}`); params.push(parseInt(max_capacity)); }
    if (activity !== undefined) { fields.push(`activity=$${idx++}`); params.push(activity); }
    if (status !== undefined) { fields.push(`status=$${idx++}`); params.push(parseInt(status)); }
    if (hour_start !== undefined) { fields.push(`hour_start=$${idx++}`); params.push(parseInt(hour_start)); }
    if (fields.length === 0) return res.json({ ok:false, error:'Rien à modifier.' });
    params.push(parseInt(req.params.id));
    await pool.query(`UPDATE slots SET ${fields.join(',')} WHERE id=$${idx}`, params);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// DELETE /api/admin/slots/:id — delete a slot (only if no active bookings)
app.delete('/api/admin/slots/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok:false });
  try {
    const check = await pool.query('SELECT COUNT(*) as nb FROM bookings WHERE slot_id=$1 AND status=1', [req.params.id]);
    if (parseInt(check.rows[0].nb) > 0) return res.json({ ok:false, error:'Impossible : des réservations actives existent.' });
    await pool.query('DELETE FROM bookings WHERE slot_id=$1', [req.params.id]);
    await pool.query('DELETE FROM slots WHERE id=$1', [req.params.id]);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ─── SLOTS ──────────────────────────────────────────────

app.get('/api/slots', async (req, res) => {
  const { start, end, activity } = req.query;
  if (!start || !end) return res.status(400).json({ ok:false });
  try {
    let sql = `SELECT s.id, TO_CHAR(s.date_slot, 'YYYY-MM-DD') AS date_slot, s.hour_start, s.activity, s.max_capacity,
      COUNT(b.id) FILTER(WHERE b.status=1) AS booked,
      (s.max_capacity - COUNT(b.id) FILTER(WHERE b.status=1)) AS remaining
      FROM slots s LEFT JOIN bookings b ON b.slot_id=s.id
      WHERE s.date_slot>=$1 AND s.date_slot<=$2 AND s.status=1`;
    const params = [start, end];
    if (activity) { sql += ' AND s.activity=$3'; params.push(activity); }
    sql += ' GROUP BY s.id ORDER BY s.date_slot,s.hour_start';
    const r = await pool.query(sql, params);
    res.json({ ok:true, slots:r.rows });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ─── BOOKING ────────────────────────────────────────────

app.post('/api/book', auth, async (req, res) => {
  const { slot_id } = req.body;
  if (!slot_id) return res.status(400).json({ ok:false, error:'Créneau requis.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock slot
    const slotRes = await client.query(
      `SELECT id, TO_CHAR(date_slot, 'YYYY-MM-DD') AS date_slot, hour_start, activity, max_capacity, status
       FROM slots WHERE id=$1 FOR UPDATE`,
      [slot_id]
    );
    if (!slotRes.rows.length) { await client.query('ROLLBACK'); return res.json({ ok:false, error:'SLOT_NOT_FOUND' }); }
    const slot = slotRes.rows[0];

    // Check past
    const slotTime = new Date(`${slot.date_slot}T${String(slot.hour_start).padStart(2,'0')}:00:00`);
    if (slotTime < new Date()) { await client.query('ROLLBACK'); return res.json({ ok:false, error:'Ce créneau est passé.' }); }

    // Check capacity
    const countRes = await client.query('SELECT COUNT(*) as nb FROM bookings WHERE slot_id=$1 AND status=1', [slot_id]);
    if (parseInt(countRes.rows[0].nb) >= slot.max_capacity) { await client.query('ROLLBACK'); return res.json({ ok:false, error:'Créneau complet.' }); }

    // Check duplicate
    const dupRes = await client.query('SELECT id FROM bookings WHERE slot_id=$1 AND user_id=$2 AND status=1', [slot_id, req.user.id]);
    if (dupRes.rows.length) { await client.query('ROLLBACK'); return res.json({ ok:false, error:'Déjà réservé.' }); }

    // Find active subscription for this activity
    const subRes = await client.query(
      `SELECT * FROM subscriptions WHERE user_id=$1 AND status='active' AND $2=ANY(activities) AND (expires_at IS NULL OR expires_at>NOW()) ORDER BY created_at DESC LIMIT 1`,
      [req.user.id, slot.activity]
    );
    if (!subRes.rows.length) { await client.query('ROLLBACK'); return res.json({ ok:false, error:'Aucun abonnement actif pour ' + slot.activity + '. Achetez un abonnement d\'abord.' }); }
    const sub = subRes.rows[0];

    // Check subscription limits
    if (sub.limit_type === 'total') {
      if (sub.sessions_used >= sub.limit_value) { await client.query('ROLLBACK'); return res.json({ ok:false, error:`Vos ${sub.limit_value} séances sont épuisées.` }); }
    } else if (sub.limit_type === 'weekly') {
      // Count bookings this week (Mon-Sun)
      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
      weekStart.setHours(0, 0, 0, 0);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      weekEnd.setHours(23, 59, 59, 999);

      const weekRes = await client.query(
        `SELECT COUNT(*) as nb FROM bookings b JOIN slots s ON s.id=b.slot_id
         WHERE b.user_id=$1 AND b.subscription_id=$2 AND b.status=1
         AND s.date_slot>=$3 AND s.date_slot<=$4`,
        [req.user.id, sub.id, weekStart.toISOString().split('T')[0], weekEnd.toISOString().split('T')[0]]
      );
      if (parseInt(weekRes.rows[0].nb) >= sub.limit_value) {
        await client.query('ROLLBACK');
        return res.json({ ok:false, error:`Limite de ${sub.limit_value} séances/semaine atteinte.` });
      }
    }

    // Insert booking
    const code = genCode();
    const bookRes = await client.query(
      'INSERT INTO bookings(slot_id,user_id,subscription_id,booking_code) VALUES($1,$2,$3,$4) RETURNING id,booking_code',
      [slot_id, req.user.id, sub.id, code]
    );

    // Increment sessions_used
    await client.query('UPDATE subscriptions SET sessions_used=sessions_used+1 WHERE id=$1', [sub.id]);

    await client.query('COMMIT');

    const remaining = slot.max_capacity - parseInt(countRes.rows[0].nb) - 1;
    broadcast('update', { slot_id: parseInt(slot_id), remaining, date_slot:slot.date_slot, hour_start:slot.hour_start, activity:slot.activity });

    res.json({ ok:true, booking_code:bookRes.rows[0].booking_code, remaining });
  } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ ok:false, error:e.message }); }
  finally { client.release(); }
});

// POST /api/cancel
app.post('/api/cancel', auth, async (req, res) => {
  const { booking_id } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const bRes = await client.query(
      `SELECT b.*, TO_CHAR(s.date_slot, 'YYYY-MM-DD') AS date_slot, s.hour_start, s.max_capacity, s.activity FROM bookings b JOIN slots s ON s.id=b.slot_id WHERE b.id=$1 AND b.user_id=$2 FOR UPDATE`,
      [booking_id, req.user.id]
    );
    if (!bRes.rows.length) { await client.query('ROLLBACK'); return res.json({ ok:false, error:'Réservation non trouvée.' }); }
    const b = bRes.rows[0];
    if (b.status !== 1) { await client.query('ROLLBACK'); return res.json({ ok:false, error:'Déjà annulée.' }); }

    const slotTime = new Date(`${b.date_slot}T${String(b.hour_start).padStart(2,'0')}:00:00`);
    const diff = slotTime - new Date();
    if (diff > 0 && diff < CONFIG.CANCEL_HOURS * 3600000) {
      await client.query('ROLLBACK');
      return res.json({ ok:false, error:`Annulation impossible moins de ${CONFIG.CANCEL_HOURS}h avant la séance.` });
    }

    await client.query('UPDATE bookings SET status=0,cancelled_at=NOW() WHERE id=$1', [booking_id]);
    // Restore session credit
    if (b.subscription_id) {
      await client.query('UPDATE subscriptions SET sessions_used=GREATEST(sessions_used-1,0) WHERE id=$1', [b.subscription_id]);
    }

    const countRes = await client.query('SELECT COUNT(*) as nb FROM bookings WHERE slot_id=$1 AND status=1', [b.slot_id]);
    const remaining = b.max_capacity - parseInt(countRes.rows[0].nb);

    await client.query('COMMIT');

    broadcast('update', { slot_id:b.slot_id, remaining, date_slot:b.date_slot, hour_start:b.hour_start, activity:b.activity });
    res.json({ ok:true, remaining });
  } catch(e) { await client.query('ROLLBACK'); res.status(500).json({ ok:false, error:e.message }); }
  finally { client.release(); }
});

// GET /api/my-bookings
app.get('/api/my-bookings', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT b.id,b.booking_code,b.status,b.created_at,b.cancelled_at,
        TO_CHAR(s.date_slot, 'YYYY-MM-DD') AS date_slot,s.hour_start,s.activity
       FROM bookings b JOIN slots s ON s.id=b.slot_id
       WHERE b.user_id=$1 ORDER BY s.date_slot DESC,s.hour_start DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ ok:true, bookings:r.rows });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ─── ADMIN: Generate Slots ──────────────────────────────
app.post('/api/admin/generate-slots', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ ok:false, error:'Admin requis.' });
  const { date_start, date_end, activities } = req.body;
  const acts = activities || ['Aquabike','Aquagym','Rééducation','Natation'];
  let count = 0;
  try {
    const current = new Date(date_start);
    const end = new Date(date_end);
    while (current <= end) {
      const dow = current.getDay();
      const dateStr = current.toISOString().split('T')[0];
      for (const act of acts) {
        const hours = getActivityHours(act, dow);
        for (const h of hours) {
          const insert = await pool.query(
            `INSERT INTO slots(date_slot,hour_start,activity,max_capacity)
             VALUES($1,$2,$3,$4)
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [dateStr, h, act, CONFIG.MAX_CAPACITY]
          );
          if (insert.rows.length) count++;
        }
      }
      current.setDate(current.getDate() + 1);
    }
    res.json({ ok:true, created:count });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// POST /api/admin/set-role
app.post('/api/admin/set-role', async (req, res) => {
  const { phone, admin_code } = req.body;
  if (admin_code !== CONFIG.ADMIN_CODE) return res.status(403).json({ ok:false });
  await pool.query("UPDATE users SET role='admin' WHERE phone=$1", [phone]);
  res.json({ ok:true });
});

// SSE
app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', Connection:'keep-alive', 'X-Accel-Buffering':'no' });
  res.write('event: connected\ndata: {}\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

initDB().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log(`[Aquabike] Port ${PORT}`));
}).catch(e => { console.error('[FATAL]', e); process.exit(1); });
