const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require("@whiskeysockets/baileys");
const P = require("pino");
const { Boom } = require("@hapi/boom");
const fs = require("fs");
const path = require("path");
const axios = require('axios');
const NodeCache = require("node-cache");

// Configurações
const BASE_AUTH_DIR = path.resolve(__dirname, "..", "..", "auth_info_baileys");
const CONFIG_FILE = path.join(BASE_AUTH_DIR, "session_config.json");
const WEBHOOK_URL = process.env.WEBHOOK_URL || "https://devdashboard.menuolika.com.br/api/whatsapp/webhook";

const msgRetryCounterCache = new NodeCache();

let globalSock = null;
let isSocketConnected = false;
let currentPhone = null;

// --- Persistência ---
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

  // Limpa instância anterior
  if (globalSock) { try { globalSock.end(); } catch {} }

  console.log(`🚀 Iniciando Socket para: ${currentPhone} (v${version.join(".")})`);

  const sock = makeWASocket({
    version,
    logger: P({ level: "silent" }),
    printQRInTerminal: false,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, P({ level: "silent" })),
    },
    browser: ["Ubuntu", "Chrome", "20.0.04"], 
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    msgRetryCounterCache,
    connectTimeoutMs: 60000,
  });

  if (!sock.authState.creds.registered) {
    console.log("⏳ Aguardando estabilização para pedir código (7s)...");
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(currentPhone.replace(/\D/g, ""));
        console.log(`\n#################################################`);
        console.log(`📠 CÓDIGO (${currentPhone}): ${code?.match(/.{1,4}/g)?.join("-")}`);
        console.log(`#################################################\n`);
        global.currentPairingCode = code;
      } catch (err) { 
        console.error("❌ Erro ao pedir código:", err.message); 
      }
    }, 7000); 
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
      
      console.log(`🔴 Desconectado (${reason}). Analisando...`);

      // 🚨 VOLTAMOS COM A LIMPEZA AUTOMÁTICA (Agora é seguro com browser Ubuntu)
      if (reason === DisconnectReason.loggedOut) {
        console.warn("🚫 Dispositivo desconectado pelo celular (401). Limpando sessão...");
        
        // Encerra socket atual para liberar arquivos
        if (globalSock) { try { globalSock.end(); } catch {} }
        
        // Apaga a pasta da sessão
        const sessionPath = path.join(BASE_AUTH_DIR, currentPhone);
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log("🗑️ Sessão inválida removida.");
        }
        
        // Reinicia do zero para gerar novo código
        setTimeout(() => startSock(), 1000);
        
      } else {
        // Outros erros (queda de internet, 500, 515) -> SÓ RECONECTA
        console.log("🔄 Queda temporária. Reconectando...");
        startSock();
      }
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    const msg = m.messages[0];
    if (!msg.key.fromMe && m.type === "notify" && !msg.key.remoteJid.includes("@g.us")) {
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
      if (text) {
        axios.post(WEBHOOK_URL, {
          phone: msg.key.remoteJid.replace("@s.whatsapp.net", ""),
          instance_phone: currentPhone,
          message: text
        }).catch(() => {});
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
  globalSock = sock;
  return sock;
};

// --- Função de Reset Manual (O Botão de Pânico) ---
const forceLogout = async () => {
  console.log("🚨 COMANDO DE RESET RECEBIDO!");
  
  if (globalSock) {
    try { globalSock.end(); } catch {}
    globalSock = null;
    isSocketConnected = false;
  }

  const phone = currentPhone || loadConfig();
  if (phone) {
    const sessionPath = path.join(BASE_AUTH_DIR, phone);
    console.warn(`🗑️ APAGANDO SESSÃO: ${sessionPath}`);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
  }

  console.log("🔄 Reiniciando sistema limpo...");
  await startSock();
  return { success: true, message: "Sessão resetada. Aguarde novo código." };
};

(async () => { await startSock(); })();

const sendMessage = async (phone, message) => {
  if (!globalSock || !isSocketConnected) throw new Error("Offline");
  const cleanPhone = phone.replace(/\D/g, "");
  const checkJid = cleanPhone.includes("@s.whatsapp.net") ? cleanPhone : `${cleanPhone}@s.whatsapp.net`;
  const [result] = await globalSock.onWhatsApp(checkJid);
  if (!result?.exists) throw new Error("Número inválido");
  const sent = await globalSock.sendMessage(result.jid, { text: message });
  return { success: true, messageId: sent.key.id };
};

module.exports = { sendMessage, startSock, isConnected: () => isSocketConnected, getCurrentPhone: () => currentPhone, forceLogout };