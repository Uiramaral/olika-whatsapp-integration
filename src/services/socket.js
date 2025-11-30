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

// 🚨 NOVO: Contador de falhas e limite
let consecutiveFailures = 0;
const MAX_FAILURES = 3; 

// --- Persistência de Configuração ---
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

const removeConfig = () => {
    if (fs.existsSync(CONFIG_FILE)) {
        fs.unlinkSync(CONFIG_FILE);
        console.log("🗑️ Configuração de número removida. STANDBY ATIVO.");
    }
};


// --- Função Core: Start do Socket ---
const startSock = async (phoneOverride = null) => {
  const phoneToUse = phoneOverride || loadConfig(); // Sem fallback para .env

  if (!phoneToUse) {
    console.log("⚠️ MODO STANDBY: Nenhum número configurado. Aguardando POST /connect.");
    globalSock = null;
    isSocketConnected = false;
    currentPhone = null;
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
    syncFullHistory: false,
    msgRetryCounterCache,
    connectTimeoutMs: 60000,
  });

  // Geração do Código de Pareamento
  if (!sock.authState.creds.registered) {
    console.log("⏳ Aguardando (15s) para pedir código...");
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
    }, 15000); 
  }

  // Monitoramento de Conexão
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.log(`✅ ${currentPhone} CONECTADO!`);
      globalSock = sock;
      isSocketConnected = true;
      global.currentPairingCode = null;
      consecutiveFailures = 0; // 👈 ZERA O CONTADOR DE SUCESSO
      
      axios.post(WEBHOOK_URL, { type: 'connection_update', instance_phone: currentPhone, status: 'CONNECTED' }).catch(() => {});
    }

    if (connection === "close") {
      isSocketConnected = false;
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      
      consecutiveFailures++; // 👈 INCREMENTA A FALHA
      console.log(`🔴 Desconectado (${reason}). Tentativa ${consecutiveFailures}/${MAX_FAILURES}.`);

      // 🔔 Webhook de Status
      axios.post(WEBHOOK_URL, { type: 'connection_update', instance_phone: currentPhone, status: 'DISCONNECTED' }).catch(() => {});


      // 🚨 NÍVEL 2/3: LOGOUT FATAL OU LIMITE DE FALHAS EXCEDIDO
      if (reason === DisconnectReason.loggedOut || consecutiveFailures >= MAX_FAILURES) {
        
        console.error("🚫 LIMITE DE FALHAS ATINGIDO ou LOGOUT FATAL. Entrando em modo STANDBY...");
        
        // 1. Notifica o Laravel para exibir o erro ao usuário
        axios.post(WEBHOOK_URL, { 
            type: 'shutdown_alert', 
            instance_phone: currentPhone, 
            reason: 'PERSISTENT_FAILURE' 
        }).catch(() => {});

        // 2. Limpeza de arquivos de sessão
        const sessionPath = path.join(BASE_AUTH_DIR, currentPhone);
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
        }
        
        // 3. Limpa a configuração de número (FORÇA o Standby)
        removeConfig();
        
        // 4. Desativa o socket global
        globalSock = null;
        global.currentPairingCode = null;
        consecutiveFailures = 0; // Zera para a próxima tentativa
        
      } else {
        // NÍVEL 1: Falha Transitória (Tenta reconectar)
        console.log("🔄 Queda temporária. Tentando reconectar...");
        startSock();
      }
    }
  });

  // Eventos Mantidos
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

// --- Funções de Controle Exportadas ---
const forceLogout = async () => {
  console.log("🚨 RESET MANUAL INICIADO!");
  
  if (globalSock) {
    try { globalSock.end(); } catch {}
    globalSock = null;
    isSocketConnected = false;
  }

  const phone = currentPhone || loadConfig();
  if (phone) {
    const sessionPath = path.join(BASE_AUTH_DIR, phone);
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    }
  }

  removeConfig(); // APAGA A CONFIG DE NÚMERO
  
  // Não chama startSock() aqui, deixa o sistema em STANDBY
  return { success: true, message: "Sessão resetada. Chame /connect para novo pareamento." };
};

// Inicialização: Tenta startar, se não tiver config, entra em STANDBY
(async () => { 
    setTimeout(async () => {
        await startSock(); 
    }, 500); 
})();

// --- Exportações ---
const sendMessage = async (phone, message) => {
    if (!globalSock || !isSocketConnected) throw new Error("Offline");
    const cleanPhone = phone.replace(/\D/g, "");
    const checkJid = cleanPhone.includes("@s.whatsapp.net") ? cleanPhone : `${cleanPhone}@s.whatsapp.net`;
    const [result] = await globalSock.onWhatsApp(checkJid);
    if (!result?.exists) throw new Error("Número inválido");
    const sent = await globalSock.sendMessage(result.jid, { text: message });
    return { success: true, messageId: sent.key.id };
};
const isConnected = () => isSocketConnected;
const getCurrentPhone = () => currentPhone;

module.exports = { sendMessage, startSock, isConnected, getCurrentPhone, forceLogout };