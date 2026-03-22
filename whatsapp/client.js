// whatsapp/client.js
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode";
import axios from "axios";
import { log, warn, dumpError } from "../utils/logger.js";
import config from "../config.js";

let sock = null;

// exported state for /qr and diagnostics
export let qrCodeData = null; // data URL when QR available
export let connectionStatus = "init"; // init|waiting|connected|disconnected|error
export let connectedNumber = null; // "91xxxxxxxxxx" when connected
export let lastCode = null; // last disconnect code

const SESSION_DIR = "whatsapp/session";

/** Pretty name for disconnect reason */
function reasonName(code) {
  const map = {
    [DisconnectReason.badSession]: "badSession",
    [DisconnectReason.connectionClosed]: "connectionClosed",
    [DisconnectReason.connectionLost]: "connectionLost",
    [DisconnectReason.connectionReplaced]: "connectionReplaced",
    [DisconnectReason.loggedOut]: "loggedOut",
    [DisconnectReason.restartRequired]: "restartRequired",
    [DisconnectReason.timedOut]: "timedOut",
  };
  return map[code] || String(code);
}

let starting = false; // prevent double start
export function isStarting() {
  return starting;
}

export async function startWhatsApp() {
  // 💡 Guard: if already connected, skip
  if (sock && connectionStatus === "connected") {
    log("⚠️ WA:start -> already connected, skipping new instance.");
    return sock;
  }

  // 💡 Guard: if starting in progress, skip
  if (starting) {
    log("⚠️ WA:start -> already starting, skip duplicate call.");
    return;
  }

  starting = true; // mark as busy
  log("WA:start -> initializing auth state at", SESSION_DIR);
  try {
    // 1️⃣ Load auth files
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    // 2️⃣ Fetch latest WA Web version
    const { version } = await fetchLatestBaileysVersion();
    log("WA:start -> using WA Web version", version);

    // 3️⃣ Create socket
    sock = makeWASocket({
      version,
      auth: state,
      browser: Browsers.windows("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });

    // 4️⃣ Save creds on update
    sock.ev.on("creds.update", async () => {
      try {
        await saveCreds();
        log("WA:creds.update -> credentials saved");
      } catch (e) {
        dumpError("WA:creds.update save error", e);
      }
    });

    // 5️⃣ Handle lifecycle
    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update || {};
      const code = lastDisconnect?.error?.output?.statusCode;
      lastCode = code;

      log(
        "WA:connection.update ->",
        JSON.stringify({ connection, hasQR: !!qr, reason: reasonName(code) })
      );

      if (qr) {
        try {
          qrCodeData = await qrcode.toDataURL(qr);
          connectionStatus = "waiting";
          log("WA:QR -> generated, CI3 can fetch via /qr");
        } catch (e) {
          connectionStatus = "error";
          qrCodeData = null;
          dumpError("WA:QR -> failed to generate", e);
        }
      }

      // ✅ Connected
      if (connection === "open") {
        connectionStatus = "connected";
        qrCodeData = null;
        const jid = sock?.user?.id || "";
        connectedNumber = jid.split("@")[0].split(":")[0] || null;
        log("✅ WA:open -> CONNECTED as", connectedNumber);

        try {
          await axios.post(
            `${config.BACKEND_URL}/admin/admin/whatsapp_connected`,
            { status: "connected", number: connectedNumber },
            { timeout: 3000 }
          );
          log("WA:notify -> CI3 connected OK");
        } catch (err) {
          warn("WA:notify -> CI3 connected event failed:", err?.message);
        }
        return;
      }

      // ❌ Disconnected
      if (connection === "close") {
        const reason = reasonName(code);
        warn("❌ WA:close -> reason =", reason, "code =", code);

        connectionStatus = "disconnected";
        connectedNumber = null;
        qrCodeData = null;

        // 🚫 prevent infinite reconnect loop on "connectionReplaced"
        if (reason === "connectionReplaced") {
          warn(
            "WA:close -> connectionReplaced (duplicate session). Not reconnecting."
          );
          return;
        }

        try {
          await axios.post(`${config.BACKEND_URL}/api/whatsapp_disconnected`, {
            status: "disconnected",
            reason,
            code,
          });
          log("WA:notify -> CI3 disconnected event sent");
        } catch (err) {
          warn("WA:notify -> CI3 disconnected event failed:", err?.message);
        }

        const fs = await import("fs");

        if (code === DisconnectReason.loggedOut) {
          warn(
            "WA:close -> loggedOut detected. Clearing session & generating new QR..."
          );
          try {
            await fs.promises.rm("./whatsapp/session", {
              recursive: true,
              force: true,
            });
            log("WA:close -> session folder wiped clean");
            setTimeout(
              () =>
                startWhatsApp().catch((e) =>
                  dumpError("WA:relogin after logout error", e)
                ),
              1500
            );
          } catch (e) {
            dumpError("WA:logout cleanup error", e);
          }
        } else {
          log("WA:close -> auto-reconnect…");
          setTimeout(
            () =>
              startWhatsApp().catch((e) =>
                dumpError("WA:auto-reconnect error", e)
              ),
            1500
          );
        }
      }
    });

    sock.ws.on("error", (e) => dumpError("WA:ws error", e));
    sock.ws.on("close", () => warn("WA:ws close -> WebSocket closed"));
  } catch (err) {
    dumpError("WA:start error", err);
  } finally {
    starting = false; // always release lock
  }
}

/** Send message */
export async function sendMessage(toMsisdn, message, isObject = false) {
  if (!sock) throw new Error("WhatsApp socket not initialized");
  if (connectionStatus !== "connected")
    throw new Error("WhatsApp not connected");

  const jid = `${toMsisdn}@s.whatsapp.net`;
  log("WA:send ->", { to: jid, message });

  // 🔹 If message is an object (e.g. media/document)
  if (isObject && typeof message === "object") {
    await sock.sendMessage(jid, message);
  } else {
    await sock.sendMessage(jid, { text: message });
  }
}

/** Force reconnect (server wipes session and restarts) */
export async function forceReconnect() {
  connectionStatus = "init";
  connectedNumber = null;
  qrCodeData = null;
  lastCode = null;
  log("WA:forceReconnect -> set to init; server will wipe session & restart");
}

/** Disconnect and logout current session */
export async function disconnectWhatsApp() {
  if (sock) {
    try {
      await sock.logout();
      log("WA:disconnect -> logged out successfully.");
    } catch (e) {
      warn("WA:disconnect -> logout error:", e.message);
    }
  }
  connectionStatus = "disconnected";
  connectedNumber = null;
  qrCodeData = null;
  lastCode = null;
}
