/**
 * Olika WhatsApp Integration — socket.js (Versão Final "Blindada")
 * Funcionalidades: Pairing Code, Auto-Restart 401, Validação de Número (9º dígito)
 */

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

// ⚙️ CONFIGURAÇÕES GLOBAIS
const USE_PAIRING_CODE = true; 
const PHONE_NUMBER = "5571987019420"; // Seu número principal
const SESSION_NAME = "5571987019420";
const SESSION_PATH = path.resolve(__dirname, "..", "..", "auth_info_baileys", SESSION_NAME);

let globalSock = null;
let isSocketConnected = false;

// 🗑️ Helper: Limpa sessão corrompida
const clearSession = async () => {
  console.log(`🗑️ [Auto-Clean] Limpando sessão em: ${SESSION_PATH}`);
  try {
    if (fs.existsSync(SESSION_PATH)) {
      fs.rmSync(SESSION_PATH, { recursive: true, force: true });
      console.log("✅ Pasta de sessão removida.");
    }
  } catch (err) {
    console.error("❌ Erro ao limpar sessão:", err);
  }
};

const startSock = async () => {
  const { version } = await fetchLatestBaileysVersion();
  
  if (!fs.existsSync(SESSION_PATH)) {
    fs.mkdirSync(SESSION_PATH, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
  const logger = P({ level: "silent" }); // Silent para logs limpos

  console.log(`🚀 Iniciando Socket (v${version.join(".")})`);

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: !USE_PAIRING_CODE,
    auth: state,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    markOnlineOnConnect: true,
    connectTimeoutMs: 60000,
  });

  // 🩺 Lógica de Pareamento (Só executa se não estiver registrado)
  if (USE_PAIRING_CODE && !sock.authState.creds.registered) {
    console.log("⏳ Aguardando estabilização para gerar código...");
    setTimeout(async () => {
      try {
        const codeNumber = PHONE_NUMBER.replace(/[^0-9]/g, "");
        const code = await sock.requestPairingCode(codeNumber);
        console.log("\n#################################################");
        console.log(`📠 CÓDIGO DE PAREAMENTO: ${code?.match(/.{1,4}/g)?.join("-")}`);
        console.log("#################################################\n");
        global.currentPairingCode = code;
      } catch (err) {
        console.error("⚠️ Aviso: Não foi possível gerar código (pode já estar conectado).");
      }
    }, 5000);
  }

  // 🧠 Monitoramento de Eventos
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.log("✅ CONECTADO OFICIALMENTE AO WHATSAPP!");
      globalSock = sock;
      isSocketConnected = true; 
    }

    if (connection === "close") {
      isSocketConnected = false;
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      console.log(`🔴 Desconectado. Motivo: ${reason}`);

      // Se for 401 (Logoff), limpa tudo e reinicia
      if (reason === DisconnectReason.loggedOut) {
        console.error("🚫 Sessão inválida (401). Executando limpeza...");
        await clearSession();
        startSock(); 
      } else {
        console.log("🔄 Tentando reconexão automática...");
        startSock();
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("messages.upsert", () => {}); // Mantém socket vivo

  globalSock = sock;
  return sock;
};

// Inicialização imediata
(async () => { await startSock(); })();

// 📤 Função de Envio Inteligente (Corrige 9º Dígito)
const sendMessage = async (phone, message) => {
  if (!globalSock || !isSocketConnected) {
    throw new Error("WhatsApp desconectado ou reconectando.");
  }

  // 1. Limpa o número
  const cleanPhone = phone.replace(/\D/g, "");
  
  // 2. Define JID para verificação
  const checkJid = cleanPhone.includes("@s.whatsapp.net") 
    ? cleanPhone 
    : `${cleanPhone}@s.whatsapp.net`;

  try {
    // 3. Pergunta ao WhatsApp qual é o ID real (com ou sem 9)
    const [result] = await globalSock.onWhatsApp(checkJid);

    if (!result || !result.exists) {
      throw new Error(`Número ${cleanPhone} não possui conta no WhatsApp.`);
    }

    // 4. Envia para o JID correto retornado pela API
    const msgResult = await globalSock.sendMessage(result.jid, { text: message });
    return { success: true, messageId: msgResult?.key?.id, sentTo: result.jid };

  } catch (err) {
    console.error(`❌ Falha no envio para ${phone}:`, err.message);
    throw new Error(err.message);
  }
};

const isConnected = () => isSocketConnected;
const getSocket = () => globalSock;

module.exports = { sendMessage, isConnected, getSocket, startSock };