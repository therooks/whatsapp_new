const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const { Boom } = require("@hapi/boom");
const axios = require("axios");
const https = require("https");
const P = require("pino");

// Create axios instance with disabled certificate verification
const axiosInstance = axios.create({
  httpsAgent: new https.Agent({
    rejectUnauthorized: false,
  }),
});

// Store active connections
const connections = {};

// Function to save connections to a JSON file
function saveConnections() {
  try {
    // We can't directly stringify the connections object because it contains socket objects
    // So we'll create a simplified version with just the necessary data
    const simplifiedConnections = {};

    for (const [unique, connection] of Object.entries(connections)) {
      simplifiedConnections[unique] = {
        qrCode: connection.qrCode,
        connected: connection.connected,
        params: connection.params,
      };
    }

    const connectionsFile = path.join(__dirname, "data", "connections.json");

    // Create data directory if it doesn't exist
    const dataDir = path.dirname(connectionsFile);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    fs.writeFileSync(
      connectionsFile,
      JSON.stringify(simplifiedConnections, null, 2)
    );
    console.log("Connections saved to disk");
  } catch (error) {
    console.error("Error saving connections:", error);
  }
}

// Function to load connections from a JSON file
async function loadConnections() {
  try {
    const connectionsFile = path.join(__dirname, "data", "connections.json");

    if (!fs.existsSync(connectionsFile)) {
      console.log("No saved connections found");
      return;
    }

    const savedData = JSON.parse(fs.readFileSync(connectionsFile, "utf8"));

    // Restore each connection with its saved data
    for (const [unique, data] of Object.entries(savedData)) {
      if (data.connected) {
        console.log(`Restoring connection for ${unique}`);
        try {
          // Create connection using the saved parameters
          connections[unique] = await createConnection(unique, data.params);
        } catch (error) {
          console.error(`Error restoring connection for ${unique}:`, error);
        }
      }
    }

    console.log(
      `Restored ${Object.keys(connections).length} connections from disk`
    );
  } catch (error) {
    console.error("Error loading connections:", error);
  }
}

// Function to make a callback to the PHP application
async function phpCallback(endpoint, params, method = "get") {
  try {
    // Use the site_url from params or default to the fallback
    const baseUrl = connections[params.unique].params.site_url;
    const callbackUrl = `${baseUrl}/whatsapp/${endpoint}`;
    console.log(`Making ${method.toUpperCase()} callback to ${callbackUrl}`);

    let response;
    if (method.toLowerCase() === "post") {
      response = await axiosInstance.post(callbackUrl, params);
    } else {
      response = await axiosInstance.get(callbackUrl, { params });
    }

    console.log(`Callback response status: ${response.status}`);
    console.log(`Callback response data:`, response.data);
    return true;
  } catch (error) {
    console.error(`Callback error for ${endpoint}:`, error.message);
    if (error.response) {
      console.error(`Error status: ${error.response.status}`);
      console.error(`Error data:`, error.response.data);
    }
    return false;
  }
}

// Function to create a new WhatsApp connection
async function createConnection(unique, params = {}) {
  // Create auth folder for this connection
  const authFolder = path.join(__dirname, "sessions", unique);
  if (!fs.existsSync(authFolder)) {
    fs.mkdirSync(authFolder, { recursive: true });
  }

  // Load auth state
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  // Create socket connection with silent logger
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Desktop"),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: true,
    logger: P({ level: "silent" }), // Disable Baileys logging
  });

  // Handle connection update
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connections[unique].qrCode = qr;
      console.log(`🟡 New QR generated for ${unique}: length=${qr.length}`);
      console.log(
        `⌛ QR expires in ~15 seconds. Make sure your PHP page refreshes it live.`
      );

      try {
        saveConnections();
      } catch (err) {
        console.error("❌ Failed to save connections:", err);
      }

      try {
        console.log("🌐 Sending QR to PHP callback...");
        const success = await phpCallback("link/qr", {
          system_token: params.system_token || "test-token",
          uid: params.uid || "1",
          unique,
          qr,
        });

        if (success) {
          console.log("✅ QR sent successfully to PHP app");
        } else {
          console.error("⚠️ QR callback failed");
        }
      } catch (err) {
        console.error("❌ Error sending QR callback:", err.message);
      }
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode !==
            DisconnectReason.loggedOut
          : true;

      console.log(
        `Connection closed for ${unique}. Reconnecting: ${shouldReconnect}`
      );

      // Send disconnect notification to PHP app
      if (
        !shouldReconnect ||
        lastDisconnect?.error?.output?.statusCode ===
          DisconnectReason.connectionClosed
      ) {
        // This indicates a logout or permanent disconnection
        await phpCallback("link/fail", {
          system_token: params.system_token || "test-token",
          api_token: params.api_token || "none",
          wsid: params.wsid || "1",
          uid: params.uid || "1",
          hash: params.hash || "test-hash",
          unique: unique,
        });
      }

      if (shouldReconnect) {
        // Store current connection parameters and auth state before reconnecting
        const existingSocket = connections[unique];
        console.log(`Reusing existing session for ${unique}`);

        // Reconnect using existing session
        try {
          // Create auth folder for this connection if it doesn't exist
          const authFolder = path.join(__dirname, "sessions", unique);
          if (!fs.existsSync(authFolder)) {
            fs.mkdirSync(authFolder, { recursive: true });
          }

          // Load auth state - should be already saved by the creds.update event
          const { state, saveCreds } = await useMultiFileAuthState(authFolder);
          const { version } = await fetchLatestBaileysVersion();

          // Create socket connection with silent logger
          const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.ubuntu("Desktop"),
            syncFullHistory: false,
            markOnlineOnConnect: false,
            generateHighQualityLinkPreview: true,
            logger: P({ level: "silent" }),
          });

          // Update connection object with new socket but preserve existing data
          connections[unique] = {
            sock,
            qrCode: existingSocket.qrCode,
            connected: false, // Will be set to true when connection opens
            params: existingSocket.params, // Preserve existing parameters
          };

          // Save connections after reconnecting
          saveConnections();

          // Set up event handlers for the new socket
          sock.ev.on("connection.update", async (update) => {
            // Event handler code already in createConnection function
            // This block needs to handle all the same events as the original
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
              // Generate and store QR code
              connections[unique].qrCode = qr;
              console.log(`QR Code generated for ${unique}`);
              // Display QR in terminal for debugging
              qrcode.generate(qr, { small: true });

              // Save connections after QR code update
              saveConnections();

              // Notify PHP application about the new QR code
              await phpCallback("link/qr", {
                system_token:
                  connections[unique].params.system_token || "test-token",
                uid: connections[unique].params.uid || "1",
                unique: unique,
                qr: qr,
              });
            }

            if (connection === "close") {
              const shouldReconnect =
                lastDisconnect?.error instanceof Boom
                  ? lastDisconnect.error.output.statusCode !==
                    DisconnectReason.loggedOut
                  : true;

              console.log(
                `Connection closed for ${unique}. Reconnecting: ${shouldReconnect}`
              );

              // Send disconnect notification to PHP app
              if (
                !shouldReconnect ||
                lastDisconnect?.error?.output?.statusCode ===
                  DisconnectReason.connectionClosed
              ) {
                // This indicates a logout or permanent disconnection
                await phpCallback("link/fail", {
                  system_token:
                    connections[unique].params.system_token || "test-token",
                  api_token: connections[unique].params.api_token || "none",
                  wsid: connections[unique].params.wsid || "1",
                  uid: connections[unique].params.uid || "1",
                  hash: connections[unique].params.hash || "test-hash",
                  unique: unique,
                });
              }

              if (shouldReconnect) {
                // Defer to outer reconnect logic to prevent recursive reconnects
                console.log(
                  `Deferring reconnection for ${unique} to outer handler`
                );
                // Will be handled by the parent scope's reconnect logic
              } else {
                // Remove from connections
                delete connections[unique];
                // Save connections after deleting one
                saveConnections();
              }
            } else if (connection === "open") {
              console.log(`Connected successfully: ${unique}`);
              connections[unique].connected = true;

              // Save connections after successful connection
              saveConnections();

              // Get the WhatsApp ID (wid) of the connected user
              const credentials = sock.authState.creds;
              const wid = credentials.me?.id; //.split(":")[0] || "";

              console.log(`Connected with WhatsApp ID: ${wid}`);

              // Send success notification to PHP app
              if (wid) {
                await phpCallback("link/success", {
                  system_token:
                    connections[unique].params.system_token || "test-token",
                  api_token: connections[unique].params.api_token || "none",
                  wsid: connections[unique].params.wsid || "1",
                  uid: connections[unique].params.uid || "1",
                  wid: wid,
                  unique: unique,
                });
              }
            }
          });

          // Save credentials on update
          sock.ev.on("creds.update", saveCreds);

          // Handle incoming messages
          sock.ev.on("messages.upsert", async (m) => {
            if (m.type === "notify") {
              for (const msg of m.messages) {
                if (!msg.key.fromMe) {
                  try {
                    // Mark the message as read
                    await sock.readMessages([msg.key]);

                    // Get message content
                    const messageContent =
                      msg.message.conversation ||
                      (msg.message.extendedTextMessage &&
                        msg.message.extendedTextMessage.text) ||
                      (msg.message.imageMessage &&
                        msg.message.imageMessage.caption) ||
                      "";

                    // Get sender info
                    const sender = msg.key.remoteJid;
                    const isGroup = sender.endsWith("@g.us");
                    let phone = "";
                    let group = "";

                    if (isGroup) {
                      phone = msg.key.participant.split("@")[0];
                      group = sender;
                    } else {
                      phone = sender.split("@")[0];
                    }

                    console.log(
                      `Received message from ${phone}: ${messageContent}`
                    );

                    // Handle file attachments
                    let fileId = "";
                    if (
                      msg.message.imageMessage ||
                      msg.message.documentMessage ||
                      msg.message.audioMessage ||
                      msg.message.videoMessage
                    ) {
                      // Download the file
                      const messageType = Object.keys(msg.message).find((key) =>
                        [
                          "imageMessage",
                          "documentMessage",
                          "audioMessage",
                          "videoMessage",
                        ].includes(key)
                      );

                      if (messageType) {
                        const stream = await sock.downloadMediaMessage(msg);
                        // Save the file - in reality this would integrate with your server's file system
                        const fileExt = messageType.replace("Message", "");
                        fileId = `${Date.now()}_${Math.floor(
                          Math.random() * 1000
                        )}.${fileExt}`;
                        const filePath = path.join(
                          __dirname,
                          "received",
                          unique,
                          fileId
                        );

                        // Ensure directory exists
                        const dir = path.dirname(filePath);
                        if (!fs.existsSync(dir)) {
                          fs.mkdirSync(dir, { recursive: true });
                        }

                        fs.writeFileSync(filePath, stream);
                        console.log(`File saved as ${fileId}`);
                      }
                    }

                    // Send message notification to PHP app
                    await phpCallback(
                      "received",
                      {
                        system_token:
                          connections[unique].params.system_token ||
                          "test-token",
                        uid: connections[unique].params.uid || "1",
                        hash: connections[unique].params.hash || "test-hash",
                        unique: unique,
                        phone: phone,
                        message: messageContent,
                        timestamp: Date.now() / 1000,
                        file: fileId,
                        group: isGroup ? group : "",
                      },
                      "post"
                    );
                  } catch (error) {
                    console.error("Error handling incoming message:", error);
                  }
                }
              }
            }
          });

          console.log(
            `Successfully set up new socket for ${unique} using existing session`
          );
        } catch (error) {
          console.error(`Error reusing session for ${unique}:`, error);
          // Fallback to creating a completely new connection
          console.log(`Falling back to new connection for ${unique}`);
          connections[unique] = await createConnection(unique, params);
        }
      } else {
        // Remove from connections
        delete connections[unique];
        // Save connections after removing one
        saveConnections();
      }
    } else if (connection === "open") {
      console.log(`Connected successfully: ${unique}`);
      connections[unique].connected = true;

      // Save connections after successful connection
      saveConnections();

      // Get the WhatsApp ID (wid) of the connected user
      const credentials = sock.authState.creds;
      const wid = credentials.me?.id; //.split(':')[0] || '';

      console.log(`Connected with WhatsApp ID: ${wid}`);

      // Send success notification to PHP app
      if (wid) {
        await phpCallback("link/success", {
          system_token: params.system_token || "test-token",
          api_token: params.api_token || "none",
          wsid: params.wsid || "1",
          uid: params.uid || "1",
          wid: wid,
          unique: unique,
        });
      }
    }
  });

  // Save credentials on update
  sock.ev.on("creds.update", saveCreds);

  // Handle incoming messages
  sock.ev.on("messages.upsert", async (m) => {
    if (m.type === "notify") {
      for (const msg of m.messages) {
        if (!msg.key.fromMe) {
          try {
            // Mark the message as read
            await sock.readMessages([msg.key]);

            // Get message content
            const messageContent =
              msg.message.conversation ||
              (msg.message.extendedTextMessage &&
                msg.message.extendedTextMessage.text) ||
              (msg.message.imageMessage && msg.message.imageMessage.caption) ||
              "";

            // Get sender info
            const sender = msg.key.remoteJid;
            const isGroup = sender.endsWith("@g.us");
            let phone = "";
            let group = "";

            if (isGroup) {
              phone = msg.key.participant.split("@")[0];
              group = sender;
            } else {
              phone = sender.split("@")[0];
            }

            console.log(`Received message from ${phone}: ${messageContent}`);

            // Handle file attachments
            let fileId = "";
            if (
              msg.message.imageMessage ||
              msg.message.documentMessage ||
              msg.message.audioMessage ||
              msg.message.videoMessage
            ) {
              // Download the file
              const messageType = Object.keys(msg.message).find((key) =>
                [
                  "imageMessage",
                  "documentMessage",
                  "audioMessage",
                  "videoMessage",
                ].includes(key)
              );

              if (messageType) {
                const stream = await sock.downloadMediaMessage(msg);
                // Save the file - in reality this would integrate with your server's file system
                const fileExt = messageType.replace("Message", "");
                fileId = `${Date.now()}_${Math.floor(
                  Math.random() * 1000
                )}.${fileExt}`;
                const filePath = path.join(
                  __dirname,
                  "received",
                  unique,
                  fileId
                );

                // Ensure directory exists
                const dir = path.dirname(filePath);
                if (!fs.existsSync(dir)) {
                  fs.mkdirSync(dir, { recursive: true });
                }

                fs.writeFileSync(filePath, stream);
                console.log(`File saved as ${fileId}`);
              }
            }

            // Send message notification to PHP app
            await phpCallback(
              "received",
              {
                system_token: params.system_token || "test-token",
                uid: params.uid || "1",
                hash: params.hash || "test-hash",
                unique: unique,
                phone: phone,
                message: messageContent,
                timestamp: Date.now() / 1000,
                file: fileId,
                group: isGroup ? group : "",
              },
              "post"
            );
          } catch (error) {
            console.error("Error handling incoming message:", error);
          }
        }
      }
    }
  });

  // Return the connection object
  return {
    sock,
    qrCode: null,
    connected: false,
    params: params, // Store the parameters for callbacks
  };
}

// Create a new WhatsApp account connection
async function create(unique, params = {}) {
  try {
    if (connections[unique]) {
      return { status: 200, data: { qr: connections[unique].qrCode } };
    }

    // Create new connection
    connections[unique] = await createConnection(unique, params);

    // Save connections after creating a new one
    saveConnections();

    // Wait a bit for QR code to generate
    await new Promise((resolve) => setTimeout(resolve, 2000));

    return {
      status: 200,
      data: {
        qr: connections[unique].qrCode || "QR_GENERATING",
      },
    };
  } catch (error) {
    console.error(`Error creating connection for ${unique}:`, error);
    return { status: 500, error: "Failed to create WhatsApp connection" };
  }
}

// Get connection status
function getStatus(unique) {
  if (!connections[unique]) {
    return { status: 404, error: "Connection not found" };
  }

  return {
    status: 200,
    data: connections[unique].connected ? "connected" : "disconnected",
  };
}

// Delete a connection
async function deleteConnection(unique) {
  if (!connections[unique]) {
    return { status: 404, error: "Connection not found" };
  }

  try {
    // First perform a proper logout from WhatsApp
    console.log(`Logging out WhatsApp connection for ${unique}`);

    // Send logout signal to WhatsApp
    if (connections[unique].sock && connections[unique].connected) {
      try {
        // Try to logout using Baileys - simulate a logout by forcing a disconnect with logout reason
        await connections[unique].sock.logout();
      } catch (logoutError) {
        console.log(
          `Standard logout failed, using alternative method: ${logoutError.message}`
        );

        // Alternative: Force logout by clearing credentials
        const authFolder = path.join(__dirname, "sessions", unique);
        if (fs.existsSync(authFolder)) {
          // Remove auth files to ensure proper logout
          const files = fs.readdirSync(authFolder);
          for (const file of files) {
            fs.unlinkSync(path.join(authFolder, file));
          }
          console.log(`Removed auth files for ${unique}`);
        }
      }
    }

    // End the socket connection
    if (connections[unique].sock) {
      connections[unique].sock.end();
    }

    // Perform extra cleanup if needed
    connections[unique].connected = false;
    connections[unique].qrCode = null;

    // Delete the connection from memory
    delete connections[unique];

    // Save connections after deleting one
    saveConnections();

    return { status: 200 };
  } catch (error) {
    console.error(`Error deleting connection ${unique}:`, error);
    return { status: 500, error: "Failed to delete connection" };
  }
}

// Send a message
async function sendMessage(unique, recipient, message) {
  if (!connections[unique] || !connections[unique].connected) {
    return { status: 400, error: "Not connected" };
  }

  try {
    const jid = recipient.includes("@")
      ? recipient
      : `${recipient}@s.whatsapp.net`;
      
    // Add presence update to mimic human behavior
    await connections[unique].sock.sendPresenceUpdate('composing', jid);
    await new Promise(resolve => setTimeout(resolve, 700 + Math.random() * 500));
    
    await connections[unique].sock.sendMessage(jid, { text: message });
    
    await connections[unique].sock.sendPresenceUpdate('paused', jid);
    return { status: 200 };
  } catch (error) {
    console.error(`Error sending message from ${unique}:`, error);
    return { status: 500, error: "Failed to send message" };
  }
}

// Send a file message
async function sendFile(unique, recipient, fileUrl, caption = "") {
  if (!connections[unique] || !connections[unique].connected) {
    return { status: 400, error: "Not connected" };
  }

  try {
    const jid = recipient.includes("@")
      ? recipient
      : `${recipient}@s.whatsapp.net`;

    // Download the file first - using axiosInstance with disabled certificate verification
    const response = await axiosInstance.get(fileUrl, {
      responseType: "arraybuffer",
    });
    const buffer = Buffer.from(response.data, "binary");

    // Determine file type based on URL extension
    const fileName = fileUrl.split("/").pop();
    const fileExt = fileName.split(".").pop().toLowerCase();

    let messageContent;

    switch (fileExt) {
      case "jpg":
      case "jpeg":
      case "png":
        messageContent = {
          image: buffer,
          caption: caption,
        };
        break;
      case "mp4":
      case "mov":
        messageContent = {
          video: buffer,
          caption: caption,
        };
        break;
      case "mp3":
      case "ogg":
      case "wav":
        messageContent = {
          audio: buffer,
          caption: caption,
        };
        break;
      case "pdf":
      case "doc":
      case "docx":
      case "xls":
      case "xlsx":
      case "txt":
      default:
        messageContent = {
          document: buffer,
          mimetype: `application/${fileExt === "txt" ? "text/plain" : fileExt}`,
          fileName: fileName,
          caption: caption,
        };
    }

    // Mimic real client behavior before sending file
    await connections[unique].sock.sendPresenceUpdate('composing', jid);
    await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));

    await connections[unique].sock.sendMessage(jid, messageContent);
    await connections[unique].sock.sendPresenceUpdate('paused', jid);
    return { status: 200 };
  } catch (error) {
    console.error(`Error sending file from ${unique}:`, error);
    return { status: 500, error: "Failed to send file" };
  }
}

// Get total number of connections
function getTotal() {
  return Object.keys(connections).length;
}

// Validate a phone number
async function validateContact(unique, address) {
  if (!connections[unique] || !connections[unique].connected) {
    return { status: 400, error: "Not connected" };
  }

  try {
    const jid = address.includes("@") ? address : `${address}@s.whatsapp.net`;
    const [result] = await connections[unique].sock.onWhatsApp(address);

    if (result && result.exists) {
      return {
        status: 200,
        data: {
          jid: jid,
        },
      };
    } else {
      return { status: 404, error: "Contact not found on WhatsApp" };
    }
  } catch (error) {
    console.error(`Error validating contact for ${unique}:`, error);
    return { status: 500, error: "Failed to validate contact" };
  }
}

// Get groups for a connection
async function getGroups(unique) {
  if (!connections[unique] || !connections[unique].connected) {
    return { status: 400, error: "Not connected" };
  }

  try {
    const groupList = await connections[
      unique
    ].sock.groupFetchAllParticipating();
    const groups = Object.entries(groupList).map(([id, group]) => ({
      id: id,
      subject: group.subject,
    }));

    return { status: 200, data: groups };
  } catch (error) {
    console.error(`Error getting groups for ${unique}:`, error);
    return { status: 500, error: "Failed to get groups" };
  }
}

// Get participants of a group
async function getGroupParticipants(unique, groupId) {
  if (!connections[unique] || !connections[unique].connected) {
    return { status: 400, error: "Not connected" };
  }

  try {
    const participants = await connections[unique].sock.groupMetadata(groupId);

    return {
      status: 200,
      data: participants.participants.map((p) => ({
        id: p.id,
        admin: p.admin ? true : false,
      })),
    };
  } catch (error) {
    console.error(
      `Error getting participants for ${unique} in group ${groupId}:`,
      error
    );
    return { status: 500, error: "Failed to get group participants" };
  }
}

// Load saved connections when the module is first required
(async () => {
  console.log("Loading saved connections...");
  await loadConnections();
})();

module.exports = {
  create,
  getStatus,
  deleteConnection,
  sendMessage,
  sendFile,
  getTotal,
  validateContact,
  getGroups,
  getGroupParticipants,
  saveConnections,
  loadConnections,
};
