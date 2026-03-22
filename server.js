// server.js
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import session from "express-session";
import bcrypt from "bcryptjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { db, testConnection } from "./db.js";
import multer from "multer";
import os from "os";
import process from "process";
import mime from "mime";

import config from "./config.js";
import {
  startWhatsApp,
  sendMessage,
  forceReconnect,
  qrCodeData,
  connectionStatus,
  connectedNumber,
  lastCode,
  disconnectWhatsApp,
} from "./whatsapp/client.js";
import { log, warn, dumpError } from "./utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSION_DIR = path.join(__dirname, "whatsapp", "session");

const upload = multer({ dest: "uploads/" });

const app = express();
app.use(cors({ credentials: true, origin: true }));
app.use(bodyParser.json());

// ====================== 🔐 SESSION ======================
app.use(session({
  secret: process.env.SESSION_SECRET || "wa_engine_x_super_secret_2024",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: false,      // set true behind HTTPS
    maxAge: 8 * 60 * 60 * 1000  // 8 hours
  }
}));

// ====================== 🔐 AUTH MIDDLEWARE ======================
// Encoded route map — base64url tokens for each page
const PAGE_ROUTES = {
  login:     '/',                // Login page (root)
  dashboard: '/d/aW5kZXg',      // base64: "index"
  contacts:  '/d/Y29udGFjdHM',  // base64: "contacts"
  logs:      '/d/bG9ncw',       // base64: "logs"
  history:   '/d/aGlzdG9yeQ',   // base64: "history"
};

const PUBLIC_PATHS = [
  '/',
  '/auth/login',
  '/auth/logout',
  '/favicon.ico',
];

function isAuthenticated(req, res, next) {
  // Always allow public paths and root (login)
  if (PUBLIC_PATHS.includes(req.path)) return next();
  // Allow static assets (css, js, fonts)
  if (req.path.match(/\.(css|js|woff2?|ttf|png|jpg|ico|svg|webp)$/)) return next();

  if (req.session && req.session.userId) {
    return next(); // logged in
  }

  // API call → return 401
  if (req.headers.accept?.includes('application/json') || req.path.startsWith('/auth') || req.path.startsWith('/qr') || req.path.startsWith('/send') || req.path.startsWith('/logs') || req.path.startsWith('/stats') || req.path.startsWith('/contacts') || req.path.startsWith('/health') || req.path.startsWith('/reconnect') || req.path.startsWith('/disconnect')) {
    return res.status(401).json({ success: false, message: 'Unauthorized. Please login.' });
  }
  // Browser → redirect to login root
  return res.redirect('/');
}

app.use(isAuthenticated);

// ====================== 🔐 AUTH ROUTES ======================

// POST /auth/login
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username and password required' });
  }
  try {
    const [rows] = await db.query(
      'SELECT * FROM wa_users WHERE username = ? AND is_active = 1 LIMIT 1',
      [username.trim()]
    );
    if (!rows.length) {
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Invalid username or password' });
    }
    await db.query('UPDATE wa_users SET last_login = NOW() WHERE id = ?', [user.id]);
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.role = user.role;
    // Return the encoded dashboard route so the client can redirect
    return res.json({ success: true, username: user.username, role: user.role, redirect: PAGE_ROUTES.dashboard });
  } catch (err) {
    console.error('[AUTH] Login error:', err.message);
    return res.status(500).json({ success: false, message: 'Server error during login' });
  }
});

// GET /auth/logout
app.get('/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login.html');
  });
});

// GET /auth/me  (check current session info)
app.get('/auth/me', (req, res) => {
  if (req.session?.userId) {
    return res.json({ loggedIn: true, username: req.session.username, role: req.session.role });
  }
  return res.json({ loggedIn: false });
});

// Simple health
app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    status: connectionStatus,
    number: connectedNumber,
    lastCode,
  })
);

// JSON for CI3
app.get("/qr", async (req, res) => {
  console.log("\n[QR API CALLED] Current status:", connectionStatus);

  try {
    if (connectionStatus === "connected") {
      return res.json({ status: "connected", number: connectedNumber });
    }

    if (connectionStatus === "waiting" && qrCodeData) {
      return res.json({ status: "waiting", qr: qrCodeData });
    }

    if (
      (connectionStatus === "disconnected" || connectionStatus === "error") &&
      !isStarting()
    ) {
      console.log("[QR API] Triggering startWhatsApp() since disconnected...");
      try {
        await startWhatsApp();
      } catch (e) {
        console.error("[QR API] startWhatsApp() error:", e);
      }
      return res.json({
        status: "restarting",
        message: "Restarting WhatsApp...",
      });
    }

    return res.json({ status: connectionStatus || "unknown" });
  } catch (err) {
    console.error("[QR API] Exception:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

// Force reconnect (wipe session -> restart)
app.get("/reconnect", async (_req, res) => {
  try {
    log("API:/reconnect -> wiping session at:", SESSION_DIR);
    if (fs.existsSync(SESSION_DIR))
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    await forceReconnect();
    await startWhatsApp();
    setTimeout(() => {
      log(
        "API:/reconnect -> status:",
        connectionStatus,
        "hasQR:",
        !!qrCodeData
      );
      res.json({
        status: connectionStatus,
        qr: qrCodeData || null,
        lastCode: lastCode ?? null,
      });
    }, 1500);
  } catch (e) {
    dumpError("API:/reconnect error", e);
    res
      .status(500)
      .json({ status: "error", message: e?.message || "reconnect failed" });
  }
});

// Disconnect explicitly
app.get("/disconnect", async (_req, res) => {
  try {
    log("API:/disconnect -> disconnecting current session");
    await disconnectWhatsApp();
    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    }
    res.json({
      status: "disconnected",
      success: true,
      message: "Successfully disconnected and wiped session"
    });
  } catch (e) {
    dumpError("API:/disconnect error", e);
    res.status(500).json({ status: "error", message: e?.message });
  }
});

// Send message
async function sendMedia(phone, filePath, fileName, caption = "") {
  try {
    const mimeType = mime.getType(filePath) || "application/octet-stream";
    const fileBuffer = fs.readFileSync(filePath);

    const messagePayload = {
      document: fileBuffer,
      mimetype: mimeType,
      fileName: fileName,
    };

    // Optional caption under document
    if (caption) messagePayload.caption = caption;

    console.log(`[WA SEND] ▶ Sending media to ${phone}: ${fileName} (${mimeType})`);
    await sendMessage(phone, messagePayload, true);
    console.log(`[WA SEND] ✅ Media sent to ${phone}`);
  } catch (err) {
    console.error(`[WA SEND] ❌ sendMedia failed for ${phone}:`, err);
    throw err;
  }
}

// ✅ Send message (uses helper from whatsapp/client.js)
app.post("/send", upload.any(), async (req, res) => {
  const {
    phone,
    message,
    category = "custom",
    sender_name = "SmartSchool",
  } = req.body || {};
  const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress;

  console.log("\n[WA SEND API] New request:", phone, message?.slice(0, 60));

  try {
    if (!phone) {
      return res
        .status(400)
        .json({ status: "error", message: "Missing phone number" });
    }

    if (connectionStatus !== "connected") {
      return res
        .status(400)
        .json({ status: "error", message: "WhatsApp not connected" });
    }

    const cleanPhone = phone.replace(/^\+/, "").replace(/\D/g, "");

    // ✅ 1. Ensure contact exists
    const [contactRows] = await db.query(
      "SELECT id FROM wa_contacts WHERE phone = ?",
      [cleanPhone]
    );
    let contactId;
    if (contactRows.length === 0) {
      const [insertContact] = await db.query(
        "INSERT INTO wa_contacts (phone, name, user_type) VALUES (?, ?, ?)",
        [cleanPhone, null, "other"]
      );
      contactId = insertContact.insertId;
    } else {
      contactId = contactRows[0].id;
    }

    // ✅ 2. Create message record (pending)
    const [msgInsert] = await db.query(
      `INSERT INTO wa_messages 
       (contact_id, message_type, message_text, category, status, ip_address, sender_name, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        contactId,
        req.files?.length > 0 ? "media" : "text",
        message || "",
        category,
        "pending",
        clientIp,
        sender_name,
        "ci3_backend",
      ]
    );
    const messageId = msgInsert.insertId;

    // ✅ 3. Create send log
    const [sendLogInsert] = await db.query(
      `INSERT INTO wa_send_log (request_id, total_messages, success_count, failed_count, source, triggered_by, trigger_ip)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        `REQ-${Date.now()}`,
        1,
        0,
        0,
        "ci3_backend",
        sender_name || "SmartSchool",
        clientIp,
      ]
    );
    const logId = sendLogInsert.insertId;

    // ✅ 4. Actual sending
    let sendStatus = "failed";

    try {
      // 🔹 Send text message first (if present)
      if (message && message.trim() !== "") {
        await sendMessage(cleanPhone, message);
        console.log(`[WA SEND] ✅ Text sent to ${cleanPhone}`);
      }

      // 🔹 Send each uploaded media file (PDF, image, etc.)
      if (req.files && req.files.length > 0) {
        for (const file of req.files) {
          const filePath = path.resolve(file.path);
          const fileName = path.basename(file.originalname || file.filename);
          console.log(`[WA SEND] 📎 Sending media: ${fileName}`);

          await sendMedia(cleanPhone, filePath, fileName);

          // Optional cleanup
          fs.unlink(filePath, (err) => {
            if (err) console.warn("Cleanup error:", err.message);
          });
        }
      }

      sendStatus = "sent";

      // ✅ Update logs
      await db.query(
        "UPDATE wa_messages SET status = ?, sent_at = NOW() WHERE id = ?",
        [sendStatus, messageId]
      );
      await db.query(
        "UPDATE wa_send_log SET success_count = success_count + 1, completed_at = NOW() WHERE id = ?",
        [logId]
      );

      res.json({
        status: "success",
        message:
          req.files?.length > 0
            ? `Message + ${req.files.length} media sent successfully`
            : "Message sent successfully",
      });
    } catch (err) {
      console.error(`[WA SEND] ❌ Failed to send to ${cleanPhone}:`, err);

      await db.query(
        "UPDATE wa_messages SET status = ?, error_message = ? WHERE id = ?",
        ["failed", err.message, messageId]
      );
      await db.query(
        "UPDATE wa_send_log SET failed_count = failed_count + 1, completed_at = NOW() WHERE id = ?",
        [logId]
      );

      res
        .status(500)
        .json({ status: "error", message: err.message || "Send failed" });
    }
  } catch (err) {
    console.error("[WA SEND ERROR]", err);
    res
      .status(500)
      .json({ status: "error", message: err?.message || "Internal error" });
  }
});

app.get("/logs/recent", async (_req, res) => {
  try {
    const [rows] = await db.query(`
      SELECT 
        m.id,
        c.phone,
        c.name,
        m.message_text,
        m.category,
        m.status,
        m.sent_at,
        m.error_message,
        m.ip_address,
        m.sender_name
      FROM wa_messages AS m
      LEFT JOIN wa_contacts AS c ON c.id = m.contact_id
      ORDER BY m.id DESC
      LIMIT 50
    `);

    res.json({
      success: true,
      count: rows.length,
      data: rows,
    });
  } catch (err) {
    console.error("[API:/logs/recent] Error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ====================== 📜 LOG HISTORY API ======================
app.get("/logs/history", async (req, res) => {
  try {
    const { start, end, status, category, search } = req.query;

    let query = `
      SELECT 
        m.id,
        c.phone,
        c.name,
        m.message_text,
        m.status,
        m.category,
        m.sent_at
      FROM wa_messages AS m
      LEFT JOIN wa_contacts AS c ON m.contact_id = c.id
      WHERE 1=1
    `;
    const params = [];

    if (start) {
      query += " AND DATE(m.sent_at) >= ?";
      params.push(start);
    }
    if (end) {
      query += " AND DATE(m.sent_at) <= ?";
      params.push(end);
    }
    if (status) {
      query += " AND m.status = ?";
      params.push(status);
    }
    if (category) {
      query += " AND m.category = ?";
      params.push(category);
    }
    if (search) {
      query +=
        " AND (c.phone LIKE ? OR m.message_text LIKE ? OR c.name LIKE ?)";
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    query += " ORDER BY m.sent_at DESC LIMIT 500";
    const [rows] = await db.query(query, params);

    // ✅ Monthly Aggregation for Chart
    const [summary] = await db.query(`
      SELECT 
        DATE_FORMAT(m.sent_at, '%Y-%m') AS month,
        m.category,
        COUNT(*) AS total
      FROM wa_messages AS m
      WHERE m.status = 'sent'
      GROUP BY DATE_FORMAT(m.sent_at, '%Y-%m'), m.category
      ORDER BY month ASC
    `);

    res.json({
      success: true,
      data: rows,
      summary,
    });
  } catch (err) {
    console.error("[API:/logs/history] Error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/stats/server", async (_req, res) => {
  try {
    const uptimeSec = process.uptime();
    const mem = process.memoryUsage().rss / 1024 / 1024;
    const cpuLoad = os.loadavg()[0];

    // Optional: record to DB for long-term analytics
    await db.query(
      `INSERT INTO wa_server_stats 
       (status, uptime_seconds, cpu_usage, memory_usage_mb, connected_number, last_health_check)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [
        connectionStatus,
        Math.round(uptimeSec),
        cpuLoad,
        mem,
        connectedNumber || null,
      ]
    );

    res.json({
      success: true,
      status: connectionStatus,
      connected_number: connectedNumber,
      uptime_seconds: Math.round(uptimeSec),
      uptime_human: `${Math.floor(uptimeSec / 3600)}h ${Math.floor(
        (uptimeSec % 3600) / 60
      )}m`,
      cpu_usage: parseFloat(cpuLoad.toFixed(2)),
      memory_usage_mb: parseFloat(mem.toFixed(2)),
      health: {
        status: connectionStatus,
        last_code: lastCode,
      },
    });
  } catch (err) {
    console.error("[API:/stats/server] Error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/stats/summary", async (_req, res) => {
  try {
    const [[msgStats], [contactsStats], [todayStats]] = await Promise.all([
      db.query(`
        SELECT 
          COUNT(*) AS total_messages,
          SUM(status='sent') AS total_sent,
          SUM(status='failed') AS total_failed
        FROM wa_messages
      `),
      db.query(`
        SELECT 
          COUNT(*) AS total_contacts,
          SUM(user_type='student') AS students,
          SUM(user_type='parent') AS parents,
          SUM(user_type='staff') AS staff
        FROM wa_contacts
      `),
      db.query(`
        SELECT 
          SUM(status='sent') AS today_sent,
          SUM(status='failed') AS today_failed
        FROM wa_messages
        WHERE DATE(sent_at) = CURDATE()
      `),
    ]);

    res.json({
      success: true,
      data: {
        total_messages: msgStats[0].total_messages || 0,
        total_sent: msgStats[0].total_sent || 0,
        total_failed: msgStats[0].total_failed || 0,
        total_contacts: contactsStats[0].total_contacts || 0,
        students: contactsStats[0].students || 0,
        parents: contactsStats[0].parents || 0,
        staff: contactsStats[0].staff || 0,
        today_sent: todayStats[0].today_sent || 0,
        today_failed: todayStats[0].today_failed || 0,
      },
    });
  } catch (err) {
    console.error("[API:/stats/summary] Error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ✅ Get all contacts
app.get("/contacts", async (req, res) => {
  try {
    const search = req.query.search ? `%${req.query.search}%` : "%";
    const [rows] = await db.query(
      `SELECT * FROM wa_contacts 
       WHERE phone LIKE ? OR name LIKE ? 
       ORDER BY id DESC LIMIT 100`,
      [search, search]
    );
    res.json({ success: true, data: rows });
  } catch (err) {
    console.error("[API:/contacts] Error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ✅ Add new contact
app.post("/contacts", async (req, res) => {
  const { phone, name, user_type = "other", reference_id = null } = req.body;
  try {
    if (!phone)
      return res
        .status(400)
        .json({ success: false, message: "Phone required" });

    const cleanPhone = phone.replace(/^\+/, "").replace(/\D/g, "");
    const [exists] = await db.query(
      "SELECT id FROM wa_contacts WHERE phone = ?",
      [cleanPhone]
    );
    if (exists.length > 0)
      return res
        .status(400)
        .json({ success: false, message: "Contact already exists" });

    const [insert] = await db.query(
      "INSERT INTO wa_contacts (phone, name, user_type, reference_id) VALUES (?, ?, ?, ?)",
      [cleanPhone, name || null, user_type, reference_id]
    );
    res.json({ success: true, id: insert.insertId });
  } catch (err) {
    console.error("[API:/contacts POST] Error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ✅ Edit contact
app.put("/contacts/:id", async (req, res) => {
  const { id } = req.params;
  const { name, user_type, reference_id } = req.body;
  try {
    await db.query(
      "UPDATE wa_contacts SET name=?, user_type=?, reference_id=?, updated_at=NOW() WHERE id=?",
      [name || null, user_type || "other", reference_id || null, id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("[API:/contacts PUT] Error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ✅ Delete contact
app.delete("/contacts/:id", async (req, res) => {
  const { id } = req.params;
  try {
    await db.query("DELETE FROM wa_contacts WHERE id = ?", [id]);
    res.json({ success: true });
  } catch (err) {
    console.error("[API:/contacts DELETE] Error:", err.message);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ====================== 🌐 PAGE ROUTES (Encoded URLs) ======================
const PUB = path.join(__dirname, 'public');

// Login (root)
app.get('/', (_req, res) => res.sendFile(path.join(PUB, 'login.html')));

// Protected encoded page routes
app.get(PAGE_ROUTES.dashboard, (req, res) => res.sendFile(path.join(PUB, 'index.html')));
app.get(PAGE_ROUTES.contacts,  (req, res) => res.sendFile(path.join(PUB, 'contacts.html')));
app.get(PAGE_ROUTES.logs,      (req, res) => res.sendFile(path.join(PUB, 'logs.html')));
app.get(PAGE_ROUTES.history,   (req, res) => res.sendFile(path.join(PUB, 'history.html')));

// Block direct .html access — redirect to their encoded equivalents
app.get('/index.html',    (_req, res) => res.redirect(301, PAGE_ROUTES.dashboard));
app.get('/contacts.html', (_req, res) => res.redirect(301, PAGE_ROUTES.contacts));
app.get('/logs.html',     (_req, res) => res.redirect(301, PAGE_ROUTES.logs));
app.get('/history.html',  (_req, res) => res.redirect(301, PAGE_ROUTES.history));
app.get('/login.html',    (_req, res) => res.redirect(301, '/'));

// Serve other static assets (CSS, JS, images) — NOT html index browsing
app.use(express.static(PUB, { index: false }));


app.listen(config.PORT, async () => {
  log(`HTTP server on http://localhost:${config.PORT}`);

  // ✅ Test MySQL connection
  await testConnection();

  try {
    await startWhatsApp();
    log("WA:start complete (waiting for events) …");
  } catch (e) {
    dumpError("FATAL: startWhatsApp failed", e);
  }
});
