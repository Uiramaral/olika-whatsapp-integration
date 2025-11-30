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

// Cache para retry
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

// --- Função de Limpeza de Sessão ---
const clearSession = (sessionPath) => {
  console.warn(`🗑️ LIMPANDO SESSÃO EM: ${sessionPath}`);
  try {
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log("✅ Pasta removida. O próximo start será limpo.");
    }
  } catch (e) {
    console.error("❌ Erro ao limpar sessão:", e.message);
  }
};

// --- Socket Logic ---
const startSock = async (phoneOverride = null) => {
  const phoneToUse = phoneOverride || loadConfig() || process.env.WHATSAPP_PHONE;

  if (!phoneToUse) {
    console.log("⚠️ AGUARDANDO COMANDO: Envie POST /connect com { phone: '...' }");
    return null;
  }

  // Salva configuração se mudou
  if (currentPhone !== phoneToUse) {
    currentPhone = phoneToUse;
    saveConfig(currentPhone);
  }

  const sessionPath = path.join(BASE_AUTH_DIR, currentPhone);
  
  // Garante a pasta
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  // Fecha socket anterior
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
    // Navegador Ubuntu (Mais estável que 'Olika Gateway')
    browser: ["Ubuntu", "Chrome", "20.0.04"], 
    markOnlineOnConnect: true,
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    msgRetryCounterCache,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000, // Aumentado para evitar timeouts
  });

  // Pairing Code Logic
  if (!sock.authState.creds.registered) {
    console.log("⏳ Preparando solicitação de código (Aguardando 7s)...");
    
    // Aumentei delay para 7s para evitar 'Connection Closed' prematuro
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
      console.log(`✅ ${currentPhone} CONECTADO E PRONTO!`);
      globalSock = sock;
      isSocketConnected = true;
    }

    if (connection === "close") {
      isSocketConnected = false;
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      
      console.log(`🔴 Desconectado. Motivo: ${reason}`);

      // LÓGICA DE AUTO-CORREÇÃO (CRUCIAL)
      if (reason === DisconnectReason.loggedOut) {
        console.error("🚫 ERRO 401: Sessão corrompida ou desconectada pelo celular.");
        console.error("🧹 Executando limpeza automática para permitir novo pareamento...");
        
        sock.end(); // Encerra conexões pendentes
        clearSession(sessionPath); // Apaga a pasta
        
        console.log("🔄 Reiniciando processo do zero...");
        setTimeout(() => startSock(), 2000); // Reinicia
      } else {
        // Outros erros (queda de net) -> Reconecta sem limpar
        console.log("🔄 Tentando reconectar (mantendo sessão)...");
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

// Start automático
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

module.exports = { sendMessage, startSock, isConnected: () => isSocketConnected, getCurrentPhone: () => currentPhone };