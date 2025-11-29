/**
 * Olika WhatsApp Integration — socket.js
 * Correção: Auto-limpeza de sessão 401 + Pairing Code
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const P = require("pino");
const { Boom } = require("@hapi/boom");
const fs = require("fs"); // Necessário para limpar a sessão
const path = require("path");

// ⚙️ CONFIGURAÇÕES
const USE_PAIRING_CODE = true; 
const PHONE_NUMBER = "5571987019420"; // Seu número
const SESSION_NAME = "5571987019420";
const SESSION_PATH = path.resolve(__dirname, "..", "auth_info_baileys", SESSION_NAME);

let globalSock = null;

// Função auxiliar para limpar a pasta de sessão
const clearSession = async () => {
  console.log(`🗑️ Limpando sessão corrompida em: ${SESSION_PATH}`);
  try {
    if (fs.existsSync(SESSION_PATH)) {
      fs.rmSync(SESSION_PATH, { recursive: true, force: true });
      console.log("✅ Pasta de sessão removida com sucesso.");
    }
  } catch (err) {
    console.error("❌ Erro ao limpar pasta de sessão:", err);
  }
};

const startSock = async () => {
  const { version } = await fetchLatestBaileysVersion();
  
  // Garante que a pasta existe antes de usar
  if (!fs.existsSync(SESSION_PATH)) {
    fs.mkdirSync(SESSION_PATH, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
  const logger = P({ level: "silent" }); // Reduzido para silent para focar no que importa

  console.log(`🚀 Iniciando Socket WhatsApp (v${version.join(".")})`);

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: !USE_PAIRING_CODE,
    auth: state,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    markOnlineOnConnect: true,
    connectTimeoutMs: 60000,
  });

  // 🩺 Lógica de Pareamento (Pairing Code)
  if (USE_PAIRING_CODE && !sock.authState.creds.registered) {
    console.log("⏳ Aguardando socket estabilizar para solicitar código...");
    
    setTimeout(async () => {
      try {
        const codeNumber = PHONE_NUMBER.replace(/[^0-9]/g, "");
        const code = await sock.requestPairingCode(codeNumber);
        
        console.log("\n#################################################");
        console.log(`📠 CÓDIGO DE PAREAMENTO: ${code?.match(/.{1,4}/g)?.join("-")}`);
        console.log("#################################################\n");
        
        global.currentPairingCode = code;
      } catch (err) {
        console.error("⚠️ Falha ao solicitar código (possível reinício necessário):", err.message);
      }
    }, 5000); // Aumentei para 5s para dar tempo do socket conectar
  }

  // 🧠 Eventos do Socket
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (connection === "open") {
      console.log("✅ CONECTADO AO WHATSAPP COM SUCESSO!");
      globalSock = sock;
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      
      console.log(`🔴 Conexão fechada. Motivo: ${reason}`);

      // SE O MOTIVO FOR 401 (Logged Out) -> LIMPEZA AUTOMÁTICA
      if (reason === DisconnectReason.loggedOut) {
        console.error("🚫 Credenciais inválidas (401). Iniciando limpeza automática...");
        await clearSession(); // Apaga a pasta
        console.log("🔄 Reiniciando socket do zero...");
        startSock(); // Reinicia limpo
      } else {
        // Outros erros (internet, timeout) -> Reconecta normal
        console.log("🔄 Tentando reconectar...");
        startSock();
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // Tratamento de mensagens simples (para manter vivo)
  sock.ev.on("messages.upsert", () => {});

  globalSock = sock;
  return sock;
};

// Inicialização
(async () => {
  await startSock();
})();

// Exportações para o app.js
const sendMessage = async (phone, message) => {
  if (!globalSock) throw new Error("WhatsApp não conectado");
  const jid = phone.includes("@s.whatsapp.net") ? phone : `${phone.replace(/\D/g, "")}@s.whatsapp.net`;
  return await globalSock.sendMessage(jid, { text: message });
};

const isConnected = () => globalSock?.ws?.readyState === 1;
const getSocket = () => globalSock;

module.exports = { sendMessage, isConnected, getSocket, startSock };