// ============================================================
//  PRIME PRIVATE FUSION — SECURE BACKEND SERVER
//  Deploy on Render.com (Free Tier)
//  All Firebase credentials are SERVER-SIDE ONLY (never exposed)
// ============================================================

const express  = require('express');
const cors     = require('cors');
const admin    = require('firebase-admin');
const fetch    = require('node-fetch');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS ─────────────────────────────────────────────────────
// Replace with your actual GitHub Pages / Vercel frontend URL
const ALLOWED_ORIGINS = [
    'https://YOUR-USERNAME.github.io',        // ← GitHub Pages URL
    'https://prime-private-fusion.vercel.app',         // ← Vercel URL
    'http://localhost:5500',                   // local dev
    'http://127.0.0.1:5500'
];

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (mobile apps, curl, etc.)
        if (!origin) return callback(null, true);
        if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    methods: ['GET'],
    credentials: false
}));

app.use(express.json());

// ── FIREBASE ADMIN INIT ───────────────────────────────────────
// Set this as an Environment Variable on Render.com dashboard:
// Key:   FIREBASE_SERVICE_ACCOUNT_JSON
// Value: Paste your full serviceAccountKey.json content as JSON string
//
// How to get it:
// 1. Firebase Console → Project Settings → Service Accounts
// 2. Click "Generate new private key"
// 3. Copy the JSON content and paste as env variable on Render

let db;
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL
        // Set FIREBASE_DATABASE_URL on Render as:
        // https://zenox-b8c57-default-rtdb.firebaseio.com
    });

    db = admin.database();
    console.log('[Firebase] Admin SDK initialized ✓');
} catch (err) {
    console.error('[Firebase] Init failed:', err.message);
    console.error('→ Set FIREBASE_SERVICE_ACCOUNT_JSON and FIREBASE_DATABASE_URL env vars on Render');
}

// ── RATE LIMITER (simple in-memory) ──────────────────────────
const requestCounts = {};
function rateLimiter(req, res, next) {
    const ip  = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    if (!requestCounts[ip]) requestCounts[ip] = [];
    requestCounts[ip] = requestCounts[ip].filter(t => now - t < 60000); // 1 min window
    if (requestCounts[ip].length > 60) {
        return res.status(429).json({ error: 'Too many requests' });
    }
    requestCounts[ip].push(now);
    next();
}
app.use(rateLimiter);

// ── SECURITY HEADERS ─────────────────────────────────────────
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    next();
});

// ════════════════════════════════════════════════════════════
//  ENDPOINT 1: GET /api/check-user/:userId
//  Checks if user key exists, is valid, and is not expired.
//  Returns: { valid, status, expiry, plan, joinDate }
// ════════════════════════════════════════════════════════════
app.get('/api/check-user/:userId', async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not initialized' });

    const userId = req.params.userId;

    // Basic sanity check — your IDs start with "PRIME-"
    if (!userId || !userId.startsWith('PRIME-') || userId.length > 20) {
        return res.status(400).json({ valid: false, status: 'INVALID_ID' });
    }

    try {
        const snapshot = await db.ref('keys/' + userId).once('value');
        const userData = snapshot.val();

        if (!userData) {
            return res.json({ valid: false, status: 'NOT_FOUND' });
        }

        let expiryDateString = '';
        let planType         = 'PREMIUM';
        let joinDate         = '';

        if (typeof userData === 'object' && userData !== null) {
            expiryDateString = userData.expiry_date || userData.expiry || 'LIFETIME';
            planType         = userData.plan      || 'PREMIUM';
            joinDate         = userData.join_date || '';
        } else {
            expiryDateString = String(userData);
        }

        if (expiryDateString === 'expired') {
            return res.json({ valid: false, status: 'EXPIRED', expiry: expiryDateString, plan: planType });
        }

        if (expiryDateString === 'LIFETIME') {
            return res.json({ valid: true, status: 'LIFETIME', expiry: 'LIFETIME', plan: planType, joinDate });
        }

        const now        = Date.now();
        const expiryTime = new Date(expiryDateString).getTime();

        if (isNaN(expiryTime)) {
            return res.json({ valid: false, status: 'INVALID_DATE' });
        }

        if (expiryTime - now <= 0) {
            // Auto-mark as expired in Firebase
            await db.ref('keys/' + userId).update({ expiry: 'expired', expiry_date: 'expired' });
            return res.json({ valid: false, status: 'EXPIRED', expiry: expiryDateString, plan: planType });
        }

        return res.json({
            valid:    true,
            status:   'ACTIVE',
            expiry:   expiryDateString,
            plan:     planType,
            joinDate: joinDate,
            msLeft:   expiryTime - now
        });

    } catch (err) {
        console.error('[check-user] Error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ════════════════════════════════════════════════════════════
//  ENDPOINT 2: GET /api/game-data?size=30
//  Server-side fetches WinGo API — client never touches it.
//  Returns: { period, result, list }
// ════════════════════════════════════════════════════════════
const WINGO_BASE = 'https://draw.ar-lottery01.com/WinGo/WinGo_1M/GetHistoryIssuePage.json';

app.get('/api/game-data', async (req, res) => {
    const pageSize = Math.min(parseInt(req.query.size) || 30, 100);

    try {
        const response = await fetch(
            `${WINGO_BASE}?pageSize=${pageSize}&pageNo=1`,
            {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (compatible; PrimeFusion/1.0)',
                    'Accept': 'application/json'
                },
                timeout: 8000
            }
        );

        if (!response.ok) {
            return res.status(502).json({ error: 'Upstream API error', upstream: response.status });
        }

        const json = await response.json();

        if (!json || !json.data || !json.data.list) {
            return res.status(502).json({ error: 'Unexpected upstream response' });
        }

        const list = json.data.list.map(item => ({
            issueNumber: item.issueNumber,
            number:      parseInt(item.number)
        })).filter(item => !isNaN(item.number));

        const latest = list[0] || null;

        return res.json({
            ok:     true,
            period: latest ? String(latest.issueNumber) : null,
            result: latest ? latest.number             : null,
            list:   list
        });

    } catch (err) {
        console.error('[game-data] Fetch error:', err.message);
        res.status(504).json({ error: 'Upstream timeout or network error' });
    }
});

// ════════════════════════════════════════════════════════════
//  ENDPOINT 3: GET /api/system-maintenance
//  Reads Firebase system/maintenance flag safely.
//  Returns: { maintenance: true/false }
// ════════════════════════════════════════════════════════════
app.get('/api/system-maintenance', async (req, res) => {
    if (!db) return res.status(503).json({ error: 'Database not initialized' });

    try {
        const snapshot = await db.ref('system/maintenance').once('value');
        const isMaintenance = snapshot.val() === true;
        res.json({ maintenance: isMaintenance });
    } catch (err) {
        console.error('[maintenance] Error:', err.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// ── 404 CATCH-ALL ─────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[Server] Running on port ${PORT}`);
});
