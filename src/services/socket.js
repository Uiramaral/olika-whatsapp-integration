import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import P from "pino";
import { Boom } from "@hapi/boom";

const startSock = async () => {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info_baileys");
  const logger = P({ level: "info" });

  let sock = makeWASocket({
    logger,
    printQRInTerminal: true,
    auth: state,
    syncFullHistory: false,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    markOnlineOnConnect: true,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000
  });

  let lastConnected = null;
  let reconnectAttempts = 0;
  let heartbeatInterval = null;

  // 🔁 Heartbeat: mantém conexão ativa no Railway
  const startHeartbeat = () => {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      try {
        if (sock?.ws?.readyState === 1) {
          sock.ws.send("ping");
          logger.info("💓 Heartbeat enviado para manter conexão viva");
        }
      } catch (err) {
        logger.warn("Falha ao enviar heartbeat:", err.message);
      }
    }, 20000);
  };

  // 🧠 Reconector com backoff progressivo
  const reconnect = async () => {
    reconnectAttempts++;
    const delay = Math.min(30000, 5000 * reconnectAttempts);
    logger.warn(`Conexão instável. Tentando reconectar em ${delay / 1000}s (tentativa ${reconnectAttempts})...`);
    await new Promise(r => setTimeout(r, delay));
    startSock();
  };

<<<<<<< HEAD
            // CORREO E LOGGING DO UPTIME
            if (lastConnected) {
                const uptime = ((Date.now() - lastConnected) / 1000 / 60).toFixed(1);
                // FIX DE SINTAXE: Template string correto para evitar o SyntaxError
                console.log( Desconectado aps  minutos online.);
            }
=======
  // 📡 Eventos principais
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
>>>>>>> 061364c4aa9495cc0f9c664e11daf8c109e45ba1

    if (connection === "open") {
      reconnectAttempts = 0;
      lastConnected = Date.now();
      logger.info("🟢 Conectado ao WhatsApp.");
      startHeartbeat();
    }

    if (connection === "close") {
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const uptime = lastConnected ? ((Date.now() - lastConnected) / 60000).toFixed(1) : "0";
      logger.warn(`🔴 Desconectado após ${uptime} minutos online. Motivo: ${reason}`);

      if (reason === DisconnectReason.loggedOut) {
        logger.error("❌ Sessão encerrada. É necessário novo pareamento (QR Code).");
      } else {
        reconnect();
      }
    }
  });

  // 🔐 Evento de credenciais salvas
  sock.ev.on("creds.update", async () => {
    await saveCreds();
    logger.info("✅ Credenciais salvas com sucesso.");
  });

  // 🧱 Tratamento global de erros
  process.on("uncaughtException", (err) => {
    logger.error("Erro não tratado:", err);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error("Promise rejeitada sem tratamento:", reason);
  });
};

// 🚀 Inicialização
startSock()
  .then(() => console.log("🚀 Servidor WhatsApp iniciado com sucesso."))
  .catch((err) => console.error("Erro ao iniciar o socket:", err));
