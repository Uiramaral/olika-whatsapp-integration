/**
 * Olika WhatsApp Integration — socket.js
 * Estável e otimizado para Railway / Baileys 6.6+
 */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import P from "pino";
import { Boom } from "@hapi/boom";

const SESSION_PATH = "./auth_info_baileys/5571987019420";

const startSock = async () => {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
  const logger = P({ level: "info" });

  let sock;
  let reconnectAttempts = 0;
  let lastConnected = null;
  let heartbeatInterval;

  // 🩺 Heartbeat ativo — evita timeout em Railway
  const startHeartbeat = () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      try {
        if (sock?.ws?.readyState === 1) {
          sock.ws.send("ping");
          logger.debug("💓 Heartbeat enviado para manter conexão viva");
        }
      } catch (err) {
        logger.warn("Erro ao enviar heartbeat:", err.message);
      }
    }, 20000);
  };

  // 🔁 Reconector com backoff
  const reconnect = async () => {
    reconnectAttempts++;
    const delay = Math.min(30000, 5000 * reconnectAttempts);
    logger.warn(
      `Conexão instável. Tentando reconectar em ${delay / 1000}s (tentativa ${reconnectAttempts})...`
    );
    await new Promise((r) => setTimeout(r, delay));
    startSock();
  };

  // 🚀 Inicializa socket
  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: true,
    auth: state,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    syncFullHistory: false,
    markOnlineOnConnect: true,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
  });

  // 🧠 Eventos principais
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info("📲 Novo código de pareamento gerado. Escaneie rapidamente!");
    }

    if (connection === "open") {
      reconnectAttempts = 0;
      lastConnected = Date.now();
      logger.info("✅ Conectado com sucesso ao WhatsApp!");
      startHeartbeat();
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const uptime = lastConnected
        ? ((Date.now() - lastConnected) / 60000).toFixed(1)
        : "0";

      logger.warn(`🔴 Desconectado após ${uptime} minutos online. Motivo: ${reason}`);

      if (reason === DisconnectReason.loggedOut) {
        logger.error(
          "🚫 Sessão encerrada. É necessário novo pareamento (QR Code)."
        );
      } else {
        reconnect();
      }
    }
  });

  // 🔐 Salvamento seguro das credenciais
  sock.ev.on("creds.update", async () => {
    try {
      await saveCreds();
      logger.info("💾 Credenciais atualizadas com sucesso!");
    } catch (err) {
      logger.error("Erro ao salvar credenciais:", err.message);
    }
  });

  // ⚠️ Tratamento global de exceções
  process.on("uncaughtException", (err) => {
    logger.error("Erro não tratado:", err);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("Promise rejeitada sem tratamento:", reason);
  });

  return sock;
};

// 🟢 Inicialização segura
(async () => {
  try {
    const sock = await startSock();
    console.log("🚀 Olika WhatsApp socket iniciado com sucesso.");
  } catch (err) {
    console.error("❌ Falha ao iniciar o socket:", err);
  }
})();
