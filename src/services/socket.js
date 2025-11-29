/**
 * Olika WhatsApp Integration — socket.js
 * Estável e otimizado para Railway / Baileys 6.6+
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const P = require("pino");
const { Boom } = require("@hapi/boom");

const SESSION_PATH = "./auth_info_baileys/5571987019420";

// Usar global.sock para compartilhar referência entre módulos
global.sock = null;

// Log do caminho de sessão para verificar se o volume está montado
console.log("📁 Usando caminho de sessão:", SESSION_PATH);

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
          
          // Manter presença ativa (opcional, mas ajuda)
          try {
            sock.sendPresenceUpdate('available');
          } catch (e) {
            // Ignorar erros de presença
          }
        }
      } catch (err) {
        logger.warn("Erro ao enviar heartbeat:", err.message);
      }
    }, 30000); // A cada 30 segundos (mais frequente para manter conexão)
  };

  // 🔁 Reconector robusto - fecha socket antigo e atualiza global.sock
  const reconnect = async () => {
    try {
      reconnectAttempts++;
      const delay = Math.min(15000, 3000 * reconnectAttempts); // Delay reduzido para evitar restart do Railway
      logger.warn(`🔄 Tentando reconectar ao WhatsApp em ${delay / 1000}s (tentativa ${reconnectAttempts})...`);

      // Fechar socket antigo antes de criar novo
      if (sock?.ws) {
        try {
          sock.ws.close();
        } catch (e) {
          // Ignorar erros ao fechar
        }
      }

      // Limpar referência antiga
      if (global.sock === sock) {
        global.sock = null;
      }

      await new Promise((r) => setTimeout(r, delay));

      // Criar nova instância e atualizar global.sock
      const newSock = await startSock();
      global.sock = newSock;
      logger.info("✅ Reconectado com sucesso!");
    } catch (err) {
      logger.error("❌ Erro ao tentar reconectar:", err.message);
      // Tentar novamente após 20 segundos
      setTimeout(reconnect, 20000);
    }
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

      // Atualiza global.sock apenas agora (quando WS existe)
      global.sock = sock;

      // Log do estado real do WebSocket
      const state = sock?.ws?.readyState;
      logger.info(`🔗 global.sock atualizado APÓS conexão. readyState: ${state}, conectado: ${state === 1}`);

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

  // Inicializar referência global (será atualizada quando conexão abrir)
  // Não atualizar aqui porque sock.ws ainda não existe
  global.sock = sock;

  // Log de estado inicial do socket (verificando global.sock para confirmar compartilhamento)
  // Nota: sock.ws pode não existir ainda neste momento
  if (global.sock?.ws?.readyState === 1) {
    logger.info("🟢 Socket está conectado no momento da inicialização.");
  } else {
    logger.warn("🕓 Socket inicializado mas aguardando conexão WebSocket.");
  }

  return sock;
};

/**
 * Envia mensagem via WhatsApp
 * @param {string} phone - Número do telefone (formato: 5511999999999 ou 5511999999999@s.whatsapp.net)
 * @param {string} message - Mensagem a ser enviada
 * @returns {Promise<{success: boolean, messageId?: string, error?: string}>}
 */
const sendMessage = async (phone, message) => {
  const sock = global.sock;
  
  // Verificar conexão antes de tentar enviar
  if (!sock) {
    throw new Error('Socket não está conectado. Aguarde a conexão ser estabelecida.');
  }
  
  // Verificar se o WebSocket está realmente conectado
  if (sock.ws?.readyState !== 1) {
    throw new Error('WebSocket não está conectado (readyState: ' + (sock.ws?.readyState || 'null') + ')');
  }
  
  if (!phone || !message) {
    throw new Error('Phone e message são obrigatórios');
  }
  
  // Normalizar número de telefone
  let normalizedPhone = phone.replace(/\D/g, ''); // Remove caracteres não numéricos
  
  // Se não terminar com @s.whatsapp.net, adicionar
  if (!phone.includes('@s.whatsapp.net')) {
    normalizedPhone = `${normalizedPhone}@s.whatsapp.net`;
  } else {
    normalizedPhone = phone;
  }
  
  try {
    // Timeout interno de 5 segundos para o sendMessage
    const sendPromise = sock.sendMessage(normalizedPhone, { text: message });
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Timeout interno: sendMessage demorou mais de 5s')), 5000);
    });
    
    const result = await Promise.race([sendPromise, timeoutPromise]);
    
    return {
      success: true,
      messageId: result?.key?.id,
    };
  } catch (error) {
    console.error('Erro ao enviar mensagem:', error);
    
    // Se for timeout, relançar com mensagem mais clara
    if (error.message.includes('Timeout')) {
      throw new Error('Timeout ao enviar mensagem. WhatsApp pode estar reconectando.');
    }
    
    throw new Error(`Falha ao enviar mensagem: ${error.message}`);
  }
};

/**
 * Verifica se o socket está conectado
 * @returns {boolean}
 */
const isConnected = () => {
  const sock = global.sock;
  if (!sock) {
    return false;
  }
  
  // Verificar estado do WebSocket
  const wsState = sock.ws?.readyState;
  
  // readyState: 0 = CONNECTING, 1 = OPEN, 2 = CLOSING, 3 = CLOSED
  // Apenas retornar true se estiver OPEN (1)
  return wsState === 1;
};

/**
 * Obtém a instância do socket (para uso interno)
 * @returns {object|null}
 */
const getSocket = () => {
  return global.sock;
};

module.exports = {
  startSock,
  sendMessage,
  isConnected,
  getSocket,
};
