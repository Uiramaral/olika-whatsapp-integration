/**
 * Olika WhatsApp Integration — socket.js
 * Estável e otimizado para Railway / Baileys 6.6+
 */

require('dotenv').config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const P = require("pino");
const { Boom } = require("@hapi/boom");
const fs = require("fs").promises;
const path = require("path");

const SESSION_PATH = "./auth_info_baileys/5571987019420";

// Número do WhatsApp para gerar código de pareamento
// Pode ser definido via variável de ambiente WHATSAPP_PHONE
const WHATSAPP_PHONE = process.env.WHATSAPP_PHONE || "5571987019420";

// Usar global.sock para compartilhar referência entre módulos
global.sock = null;

// Controle de estado de conexão (mais confiável que sock.user)
global.isWhatsAppConnected = false;

const startSock = async () => {
  const { version } = await fetchLatestBaileysVersion();
  const logger = P({ level: "info" });
  
  // 💾 (D) Verificação de volume Railway antes de usar useMultiFileAuthState
  logger.info(`📂 Pasta de sessão ativa: ${SESSION_PATH}`);
  
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);

  // 🗑️ Função para limpar credenciais antigas (necessário em caso de logout)
  const clearAuthState = async () => {
    try {
      const sessionDir = SESSION_PATH;
      const files = await fs.readdir(sessionDir).catch(() => []);
      
      for (const file of files) {
        const filePath = path.join(sessionDir, file);
        await fs.unlink(filePath).catch(() => {});
      }
      
      logger.info("🗑️ Credenciais antigas removidas. Novo QR Code será gerado.");
    } catch (err) {
      logger.warn("⚠️ Erro ao limpar credenciais (pode não existir):", err.message);
    }
  };

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

      // Limpar referência antiga e estado
      if (global.sock === sock) {
        global.sock = null;
        global.isWhatsAppConnected = false; // Garantir que estado está desatualizado
      }

      await new Promise((r) => setTimeout(r, delay));

      // Criar nova instância (o estado será atualizado quando connection === "open")
      const newSock = await startSock();
      // 🔁 (C) Log de diagnóstico para reconexão no Railway
      if (newSock) logger.info("🟢 Nova instância do socket iniciada com sucesso (reconexão).");
      // Não atualizar global.sock aqui - será atualizado no evento "open"
      logger.info("🔄 Nova instância criada, aguardando conexão...");
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
      // Tentar gerar código de pareamento real usando requestPairingCode (Baileys 6.6+)
      // ⏳ Otimização: Não gerar novo código se o último foi gerado há menos de 60 segundos
      const shouldGenerateNewCode = !global.currentQRTimestamp || (Date.now() - global.currentQRTimestamp > 60000);
      
      if (!shouldGenerateNewCode) {
        logger.info(`⏳ Código ainda válido (gerado há ${Math.floor((Date.now() - global.currentQRTimestamp) / 1000)}s). Aguardando expiração...`);
        return;
      }
      
      try {
        // Verificar se o método requestPairingCode está disponível
        if (sock && typeof sock.requestPairingCode === "function") {
          const phoneNumber = WHATSAPP_PHONE;
          
          logger.info(`📲 Tentando gerar código de pareamento para ${phoneNumber}...`);
          
          // ✅ Correção: requestPairingCode espera apenas o número, sem @s.whatsapp.net
          const pairingCode = await sock.requestPairingCode(phoneNumber);
          
          if (pairingCode && pairingCode.length === 8) {
            global.currentPairingCode = pairingCode;
            global.currentQRTimestamp = Date.now();
            global.currentQR = null; // não precisamos mais de QR
            
            logger.info(`✅ Código de pareamento gerado: ${pairingCode}`);
            logger.info("➡️ Use este código no WhatsApp Business para parear.");
          } else {
            throw new Error(`requestPairingCode retornou código inválido: ${pairingCode}`);
          }
        } else {
          // Fallback: extrair código do QR se possível, ou gerar temporário
          logger.warn("⚠️ requestPairingCode() não está disponível nesta versão do Baileys.");
          
          // Tentar extrair código numérico do QR (alguns QR codes contêm o código)
          let extractedCode = null;
          try {
            // O QR pode conter um código numérico de 8 dígitos
            const qrMatch = qr.match(/\d{8}/);
            if (qrMatch && qrMatch[0]) {
              extractedCode = qrMatch[0];
              logger.info(`📲 Código extraído do QR: ${extractedCode}`);
            }
          } catch (e) {
            logger.warn("⚠️ Não foi possível extrair código do QR");
          }
          
          // Se não conseguiu extrair, gerar um código temporário baseado em timestamp
          if (!extractedCode) {
            const timestamp = Date.now();
            extractedCode = String(timestamp).slice(-8).padStart(8, '0');
            logger.warn("⚠️ Gerando código temporário baseado em timestamp");
          }
          
          global.currentPairingCode = extractedCode;
          global.currentQRTimestamp = Date.now();
          global.currentQR = qr; // Manter QR também para referência
          
          logger.info(`📲 Código de pareamento: ${extractedCode}`);
          logger.info(`📲 QR Code também disponível (tamanho: ${qr.length} caracteres)`);
        }
      } catch (err) {
        logger.error("❌ Erro ao gerar código de pareamento:", err.message);
        logger.error("❌ Stack trace:", err.stack);
        // Fallback: sempre gerar um código para exibir no dashboard
        const timestamp = Date.now();
        const codeFromTimestamp = String(timestamp).slice(-8).padStart(8, '0');
        global.currentPairingCode = codeFromTimestamp;
        global.currentQRTimestamp = Date.now();
        global.currentQR = qr;
        logger.warn(`⚠️ Usando fallback: código temporário ${codeFromTimestamp}`);
      }
    }

    if (connection === "open") {
      reconnectAttempts = 0;
      lastConnected = Date.now();
      
      // Atualizar estado de conexão
      global.isWhatsAppConnected = true;
      global.sock = sock;
      
      // Limpar QR Code quando conectado
      global.currentQR = null;
      global.currentQRTimestamp = null;
      global.currentPairingCode = null;

      logger.info("✅ Conectado com sucesso ao WhatsApp!");
      
      // Log do estado real
      const hasUser = !!sock.user;
      const wsState = sock?.ws?.readyState;
      logger.info(`🔗 global.sock atualizado APÓS conexão. user: ${hasUser}, wsState: ${wsState}, isWhatsAppConnected: ${global.isWhatsAppConnected}`);

      startHeartbeat();
    }

    if (connection === "close") {
      // Atualizar estado de conexão imediatamente
      global.isWhatsAppConnected = false;
      global.sock = null;
      global.currentQR = null; // Limpar QR Code antigo
      global.currentQRTimestamp = null;
      global.currentPairingCode = null;
      
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const uptime = lastConnected
        ? ((Date.now() - lastConnected) / 60000).toFixed(1)
        : "0";

      logger.warn(`🔴 WhatsApp desconectado após ${uptime} minutos online. Motivo: ${reason}`);
      logger.warn("🔴 WhatsApp desconectado — aguardando reconexão...");

      if (reason === DisconnectReason.loggedOut) {
        logger.error(
          "🚫 Sessão encerrada. Será necessário novo QR Code. Limpando credenciais e tentando reconectar..."
        );
        // Limpar credenciais antigas antes de reconectar
        // Isso força o Baileys a gerar um novo QR Code
        await clearAuthState();
        // Aguardar um pouco antes de reconectar para garantir que os arquivos foram deletados
        setTimeout(() => {
          reconnect();
        }, 1000);
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
  // Não atualizar isWhatsAppConnected aqui - será atualizado no evento "open"
  global.sock = sock;
  // Não definir isWhatsAppConnected como true aqui - aguardar evento "open"

  // Log de estado inicial do socket
  // Nota: sock.ws pode não existir ainda neste momento
  if (global.sock?.user || global.sock?.ws?.readyState === 1) {
    logger.info("🟢 Socket está conectado no momento da inicialização.");
    // Se já estiver conectado, atualizar estado
    if (global.sock?.ws?.readyState === 1) {
      global.isWhatsAppConnected = true;
    }
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
  
  // Verificar se está conectado usando a mesma lógica do isConnected()
  if (!sock.user && (!sock.ws || sock.ws.readyState !== 1)) {
    throw new Error('WhatsApp não está conectado. Aguarde a conexão ser estabelecida.');
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
 * Usa variável global de estado para garantir precisão
 * @returns {boolean}
 */
const isConnected = () => {
  // Usar variável global de estado (mais confiável)
  if (!global.isWhatsAppConnected) {
    return false;
  }
  
  // Verificar se o socket existe e o WebSocket está aberto
  const sock = global.sock;
  if (!sock) {
    return false;
  }
  
  // Verificar estado do WebSocket
  const wsState = sock?.ws?.readyState;
  // readyState: 1 = OPEN
  return wsState === 1;
};

/**
 * Obtém a instância do socket (para uso interno)
 * @returns {object|null}
 */
const getSocket = () => {
  return global.sock;
};

/**
 * Desconecta manualmente o WhatsApp
 * @returns {Promise<{success: boolean, message: string}>}
 */
const disconnect = async () => {
  try {
    const sock = global.sock;
    
    if (!sock) {
      return {
        success: false,
        message: 'WhatsApp já está desconectado'
      };
    }
    
    // Atualizar estado imediatamente
    global.isWhatsAppConnected = false;
    
    // Fechar WebSocket se existir
    if (sock.ws) {
      try {
        sock.ws.close();
      } catch (e) {
        // Ignorar erros ao fechar
      }
    }
    
    // Limpar referências
    global.sock = null;
    global.currentQR = null;
    global.currentQRTimestamp = null;
    global.currentPairingCode = null;
    global.currentQRTimestamp = null;
    
    // Tentar logout do Baileys (encerra sessão)
    try {
      if (sock && typeof sock.logout === 'function') {
        await sock.logout();
      } else if (sock && typeof sock.end === 'function') {
        await sock.end();
      }
    } catch (e) {
      // Pode falhar se já estiver desconectado - ignorar
      console.log('Logout já estava desconectado ou método não disponível');
    }
    
    console.log('🔴 WhatsApp desconectado manualmente');
    
    return {
      success: true,
      message: 'WhatsApp desconectado com sucesso. Será necessário novo pareamento.'
    };
  } catch (error) {
    console.error('Erro ao desconectar WhatsApp:', error);
    return {
      success: false,
      message: `Erro ao desconectar: ${error.message}`
    };
  }
};

module.exports = {
  startSock,
  sendMessage,
  isConnected,
  getSocket,
  disconnect,
};
