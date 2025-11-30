const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const P = require("pino");
const { Boom } = require("@hapi/boom");
const fs = require("fs");
const path = require("path");
const axios = require('axios');

// Caminhos e Configurações
const BASE_AUTH_DIR = path.resolve(__dirname, "..", "..", "auth_info_baileys");
const CONFIG_FILE = path.join(BASE_AUTH_DIR, "session_config.json");
const WEBHOOK_URL = process.env.WEBHOOK_URL || "https://devdashboard.menuolika.com.br/api/whatsapp/webhook";

let globalSock = null;
let isSocketConnected = false;
let currentPhone = null;

// --- Persistência (Lê qual número este container deve usar) ---
const loadConfig = () => {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).phone;
    }
  } catch (e) { return null; }
  return null;
};

const saveConfig = (phone) => {
  if (!fs.existsSync(BASE_AUTH_DIR)) fs.mkdirSync(BASE_AUTH_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ phone }));
};

// --- Socket Logic ---
const startSock = async (phoneOverride = null) => {
  const phoneToUse = phoneOverride || loadConfig() || process.env.WHATSAPP_PHONE;

  if (!phoneToUse) {
    console.log("⚠️ AGUARDANDO COMANDO: Envie POST /connect com { phone: '...' }");
    return null;
  }

  if (currentPhone !== phoneToUse) {
    currentPhone = phoneToUse;
    saveConfig(currentPhone);
  }

  const sessionPath = path.join(BASE_AUTH_DIR, currentPhone);
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  // Reset do socket anterior
  if (globalSock) { try { globalSock.end(); } catch {} }

  console.log(`🚀 Iniciando para: ${currentPhone}`);

  const sock = makeWASocket({
    version,
    logger: P({ level: "silent" }),
    printQRInTerminal: false,
    auth: state,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    markOnlineOnConnect: true,
    connectTimeoutMs: 60000,
  });

  // Pairing Code Logic
  if (!sock.authState.creds.registered) {
    console.log("⏳ Gerando código de pareamento...");
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(currentPhone.replace(/\D/g, ""));
        console.log(`\n📠 CÓDIGO (${currentPhone}): ${code?.match(/.{1,4}/g)?.join("-")}\n`);
        global.currentPairingCode = code;
      } catch (err) { console.error("Erro pairing:", err.message); }
    }, 4000);
  }

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "open") {
      console.log(`✅ ${currentPhone} CONECTADO!`);
      globalSock = sock;
      isSocketConnected = true;
    }
    if (connection === "close") {
      isSocketConnected = false;
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        console.error("🚫 401 Logged Out. Limpando...");
        fs.rmSync(sessionPath, { recursive: true, force: true });
        startSock();
      } else {
        startSock();
      }
    }
  });

  // Webhook para IA (Laravel)
  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.key.fromMe && m.type === "notify" && !msg.key.remoteJid.includes("@g.us")) {
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
      if (text) {
        axios.post(WEBHOOK_URL, {
          phone: msg.key.remoteJid.replace("@s.whatsapp.net", ""),
          instance_phone: currentPhone, // CRUCIAL: Identifica a instância
          message: text
        }).catch(() => {});
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
  globalSock = sock;
  return sock;
};

// Start automático
(async () => { await startSock(); })();

// API Export
const sendMessage = async (phone, message) => {
  if (!globalSock || !isSocketConnected) throw new Error("Offline");
  
  // Corrige 9º dígito validando no WhatsApp
  const cleanPhone = phone.replace(/\D/g, "");
  const checkJid = cleanPhone.includes("@s.whatsapp.net") ? cleanPhone : `${cleanPhone}@s.whatsapp.net`;
  
  const [result] = await globalSock.onWhatsApp(checkJid);
  if (!result?.exists) throw new Error("Número inválido");
  
  const sent = await globalSock.sendMessage(result.jid, { text: message });
  return { success: true, messageId: sent.key.id };
};

module.exports = { sendMessage, startSock, isConnected: () => isSocketConnected, getCurrentPhone: () => currentPhone };