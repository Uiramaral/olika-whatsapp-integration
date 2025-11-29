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

// ✅ CORREÇÃO: Usar caminho absoluto para garantir compatibilidade com Railway Volume
// No Railway, o WORKDIR é /app, então o caminho será /app/auth_info_baileys/{numero}
const SESSION_BASE_DIR = path.resolve(process.cwd(), "auth_info_baileys");

// Usar global.sock para compartilhar referência entre módulos
global.sock = null;

// Controle de estado de conexão (mais confiável que sock.user)
global.isWhatsAppConnected = false;

// Número do WhatsApp atual (do banco de dados)
global.currentWhatsAppPhone = null;

// Usuário conectado (número pareado) - salvo quando conexão abre
global.whatsappUser = null;

// Variáveis para watchdog de reconexão automática
global.lastConnectedAt = null;
global.lastAttemptAt = Date.now();

/**
 * Função utilitária de restart automático
 * Encerra conexão atual e inicia nova sessão
 */
async function restartWhatsAppConnection() {
  const logger = P({ level: "info" });
  
  if (global.sock) {
    logger.info("🔁 Encerrando conexão atual antes de reiniciar...");
    try {
      if (global.sock.logout) {
        await global.sock.logout();
      }
    } catch (e) {
      logger.warn("ℹ️ Logout falhou (provavelmente já desconectado):", e.message);
    }
    try {
      if (global.sock.ws) {
        global.sock.ws.close();
      }
      if (global.sock.end) {
        await global.sock.end();
      }
    } catch (e) {
      logger.warn("ℹ️ Erro ao encerrar socket:", e.message);
    }
  }
  
  // Limpar estado global
  global.sock = null;
  global.isWhatsAppConnected = false;
  global.whatsappUser = null;
  global.currentQR = null;
  global.currentQRTimestamp = null;
  global.currentPairingCode = null;
  
  logger.info("🔁 Iniciando nova sessão WhatsApp automaticamente...");
  
  // Buscar número atual (prioridade: global > env > padrão)
  const phone = global.currentWhatsAppPhone || process.env.WHATSAPP_PHONE || "5571987019420";
  
  try {
    await startSock(phone);
  } catch (err) {
    logger.error("❌ Erro ao reiniciar conexão:", err.message);
    throw err;
  }
}

const startSock = async (whatsappPhone = null) => {
  const { version } = await fetchLatestBaileysVersion();
  const logger = P({ level: "info" });
  
  // 🔒 Encerrar conexões anteriores ao iniciar nova
  if (global.sock) {
    logger.warn("⚠️ Encerrando conexão anterior antes de iniciar nova...");
    try {
      await global.sock.logout();
      logger.info("✅ Logout da conexão anterior realizado");
    } catch (e) {
      logger.warn("ℹ️ Logout falhou (provavelmente já desconectado):", e.message);
    }
    try {
      if (global.sock.ws) {
        global.sock.ws.close();
      }
      if (global.sock.end) {
        await global.sock.end();
      }
    } catch (e) {
      logger.warn("ℹ️ Erro ao encerrar socket anterior:", e.message);
    }
    global.sock = null;
    global.isWhatsAppConnected = false;
    global.whatsappUser = null;
  }
  
  // Número do WhatsApp (recebido como parâmetro ou do ambiente)
  // ✅ PRIORIDADE: Parâmetro > Global > .env > Padrão
  const WHATSAPP_PHONE = whatsappPhone || global.currentWhatsAppPhone || process.env.WHATSAPP_PHONE || "5571987019420";
  const SESSION_PATH = path.resolve(SESSION_BASE_DIR, WHATSAPP_PHONE);
  
  // Atualizar número global se foi passado como parâmetro
  if (whatsappPhone) {
    global.currentWhatsAppPhone = whatsappPhone;
  }
  
  logger.info(`═══════════════════════════════════════════════════════════`);
  logger.info(`📱 INICIANDO CONEXÃO WHATSAPP`);
  logger.info(`📱 Número configurado: ${WHATSAPP_PHONE}`);
  logger.info(`📱 Fonte: ${whatsappPhone ? 'Dashboard (banco de dados - parâmetro)' : global.currentWhatsAppPhone ? 'Banco de dados (global)' : process.env.WHATSAPP_PHONE ? 'Variável de ambiente (.env)' : 'Padrão'}`);
  logger.info(`📱 process.env.WHATSAPP_PHONE: ${process.env.WHATSAPP_PHONE || 'não definido'}`);
  logger.info(`📱 global.currentWhatsAppPhone: ${global.currentWhatsAppPhone || 'não definido'}`);
  logger.info(`═══════════════════════════════════════════════════════════`);
  
  // 💾 Verificação e criação do diretório de sessão
  try {
    // Garantir que o diretório base existe
    await fs.mkdir(SESSION_BASE_DIR, { recursive: true });
    // Garantir que o diretório da sessão existe
    await fs.mkdir(SESSION_PATH, { recursive: true });
    
    // Verificar se o diretório é gravável
    await fs.access(SESSION_PATH, fs.constants.W_OK);
    
    // Log detalhado para diagnóstico
    logger.info(`📂 Diretório de trabalho: ${process.cwd()}`);
    logger.info(`📂 Diretório base de sessões: ${SESSION_BASE_DIR}`);
    logger.info(`📂 Pasta de sessão ativa (absoluta): ${SESSION_PATH}`);
    
    // Listar arquivos existentes para diagnóstico
    const existingFiles = await fs.readdir(SESSION_PATH).catch(() => []);
    if (existingFiles.length > 0) {
      logger.info(`📄 Arquivos de sessão existentes: ${existingFiles.join(", ")}`);
    } else {
      logger.warn("⚠️ Nenhum arquivo de sessão encontrado. Nova autenticação será necessária.");
    }
  } catch (err) {
    logger.error(`❌ Erro ao verificar/criar diretório de sessão: ${err.message}`);
    logger.error(`❌ Caminho tentado: ${SESSION_PATH}`);
    throw err; // Falhar se não conseguir criar/acessar o diretório
  }
  
  // 🗑️ Função para limpar credenciais antigas (necessário em caso de logout)
  const clearAuthState = async () => {
    try {
      const sessionDir = SESSION_PATH;
      const files = await fs.readdir(sessionDir).catch(() => []);
      
      for (const file of files) {
        const filePath = path.join(sessionDir, file);
        await fs.unlink(filePath).catch(() => {});
      }
      
      logger.info("🗑️ Credenciais antigas removidas. Novo código de pareamento será gerado.");
    } catch (err) {
      logger.warn("⚠️ Erro ao limpar credenciais (pode não existir):", err.message);
    }
  };

  // ⚠️ LIMPEZA FORÇADA: Se FORCE_CLEAR_AUTH_STATE=true, limpa sessão corrompida antes de iniciar
  // Use esta variável de ambiente APENAS quando precisar limpar uma sessão corrompida
  // Após o pareamento funcionar, REMOVA a variável ou defina como false
  const FORCE_CLEAR_AUTH = process.env.FORCE_CLEAR_AUTH_STATE === 'true' || process.env.FORCE_CLEAR_AUTH_STATE === '1';
  
  if (FORCE_CLEAR_AUTH) {
    logger.warn("⚠️ FORCE_CLEAR_AUTH_STATE ativado - Limpando sessão corrompida...");
    logger.warn("⚠️ ATENÇÃO: Esta é uma ação destrutiva. Remova a variável após o pareamento funcionar!");
    await clearAuthState();
    logger.info("✅ Sessão limpa. Nova autenticação será necessária.");
  }
  
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);

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
      // ✅ Usar número do banco de dados (armazenado globalmente) em vez do .env
      const reconnectPhone = global.currentWhatsAppPhone || process.env.WHATSAPP_PHONE || "5571987019420";
      logger.info(`🔄 Reconectando para número: ${reconnectPhone}`);
      logger.info(`📱 Fonte do número na reconexão: ${global.currentWhatsAppPhone ? 'Banco de dados (global)' : process.env.WHATSAPP_PHONE ? 'Variável de ambiente' : 'Padrão'}`);
      const newSock = await startSock(reconnectPhone);
      // 🔁 (C) Log de diagnóstico para reconexão no Railway
      if (newSock) logger.info(`🟢 Nova instância do socket iniciada com sucesso (reconexão) para número: ${reconnectPhone}`);
      // Não atualizar global.sock aqui - será atualizado no evento "open"
      logger.info("🔄 Nova instância criada, aguardando conexão...");
    } catch (err) {
      logger.error("❌ Erro ao tentar reconectar:", err.message);
      // Tentar novamente após 20 segundos
      setTimeout(reconnect, 20000);
    }
  };

  // 🚀 Inicializa socket
  logger.info(`🔌 Criando socket Baileys para número: ${WHATSAPP_PHONE}`);
  logger.info(`🔌 Versão Baileys: ${version.join('.')}`);
  
  sock = makeWASocket({
    version,
    logger,
    // printQRInTerminal foi removido na v2.3000+ - QR/código agora vem via connection.update
    auth: state,
    browser: ["Ubuntu", "Chrome", "20.0.04"],
    syncFullHistory: false,
    markOnlineOnConnect: true,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
  });
  
  logger.info(`✅ Socket Baileys criado para número: ${WHATSAPP_PHONE}`);

  // 🧠 Eventos principais
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr, pairingCode, isNewLogin } = update;
    const statusCode = lastDisconnect?.error?.output?.statusCode;

    // 🔍 Depuração completa
    logger.info("📡 connection.update =>", {
      connection,
      hasQR: !!qr,
      hasPairingCode: !!pairingCode,
      pairingCode: pairingCode || null,
      isNewLogin,
      statusCode,
      hasLastDisconnect: !!lastDisconnect
    });

    // ✅ Capturar pairingCode diretamente do evento (Baileys v2.3000+)
    if (pairingCode) {
      global.currentPairingCode = pairingCode;
      global.currentQRTimestamp = Date.now();
      global.currentQR = qr || null; // Manter QR também se disponível
      
      logger.info(`🔢 Código de pareamento recebido do evento: ${pairingCode}`);
      logger.info("➡️ Use este código no WhatsApp Business para parear.");
    }

    // ✅ Capturar QR Code diretamente do evento (fallback)
    if (qr) {
      global.currentQR = qr;
      global.currentQRTimestamp = Date.now();
      logger.info(`📱 Novo QR Code gerado. Escaneie com o app WhatsApp.`);
      
      // Se não tiver pairingCode ainda, tentar gerar via requestPairingCode
      if (!global.currentPairingCode) {
        logger.info(`📱 Tentando gerar código de pareamento via requestPairingCode...`);
        
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
            
            // ✅ Correção: requestPairingCode precisa do prefixo "+" no número
            // Formato esperado: "+5571987019420" (com +, sem @s.whatsapp.net)
            const formattedPhone = phoneNumber.startsWith('+')
              ? phoneNumber
              : `+${phoneNumber}`;
            
            logger.info(`📲 Número formatado para pareamento: ${formattedPhone}`);
            const pairingCode = await sock.requestPairingCode(formattedPhone);
            
            if (pairingCode && pairingCode.length === 8) {
              global.currentPairingCode = pairingCode;
              global.currentQRTimestamp = Date.now();
              
              logger.info(`✅ Código de pareamento gerado via requestPairingCode: ${pairingCode}`);
              logger.info("➡️ Use este código no WhatsApp Business para parear.");
            } else {
              throw new Error(`requestPairingCode retornou código inválido: ${pairingCode}`);
            }
          } else {
            // Fallback: extrair código do QR se possível
            logger.warn("⚠️ requestPairingCode() não está disponível nesta versão do Baileys.");
            
            // Tentar extrair código numérico do QR (alguns QR codes contêm o código)
            let extractedCode = null;
            try {
              const qrMatch = qr.match(/\d{8}/);
              if (qrMatch && qrMatch[0]) {
                extractedCode = qrMatch[0];
                logger.info(`📲 Código extraído do QR: ${extractedCode}`);
              }
            } catch (e) {
              logger.warn("⚠️ Não foi possível extrair código do QR");
            }
            
            if (extractedCode) {
              global.currentPairingCode = extractedCode;
              global.currentQRTimestamp = Date.now();
              logger.info(`📲 Código de pareamento extraído do QR: ${extractedCode}`);
            }
          }
        } catch (err) {
          logger.error("❌ Erro ao gerar código de pareamento:", err.message);
          logger.error("❌ Stack trace:", err.stack);
        }
      }
    }

    if (connection === "connecting") {
      logger.info("🕓 Conectando ao WhatsApp...");
    }

    if (connection === "open") {
      reconnectAttempts = 0;
      lastConnected = Date.now();
      
      // Atualizar estado de conexão
      global.isWhatsAppConnected = true;
      global.sock = sock;
      global.lastConnectedAt = Date.now(); // Atualizar timestamp para watchdog
      
      // ✅ Salva o usuário logado (por ex: número pareado)
      const userJid = sock.user?.id;
      global.whatsappUser = userJid || null;
      
      // Limpar QR Code quando conectado
      global.currentQR = null;
      global.currentQRTimestamp = null;
      global.currentPairingCode = null;

      logger.info(`═══════════════════════════════════════════════════════════`);
      logger.info(`🟢 Conexão com o WhatsApp aberta!`);
      logger.info(`✅ WhatsApp conectado como ${userJid || 'desconhecido'}`);
      logger.info(`📱 Número configurado: ${WHATSAPP_PHONE}`);
      logger.info(`═══════════════════════════════════════════════════════════`);
        
      // Log do estado real
      const hasUser = !!sock.user;
      const wsState = sock?.ws?.readyState;
      logger.info(`🔗 global.sock atualizado APÓS conexão. user: ${hasUser}, wsState: ${wsState}, isWhatsAppConnected: ${global.isWhatsAppConnected}`);
      logger.info(`👤 Usuário salvo globalmente: ${global.whatsappUser}`);
        
      // ✅ Verificar se as credenciais foram salvas
      try {
        const credsFile = path.join(SESSION_PATH, "creds.json");
        const credsExists = await fs.access(credsFile).then(() => true).catch(() => false);
        if (credsExists) {
          logger.info(`✅ Credenciais salvas em: ${credsFile}`);
        } else {
          logger.warn(`⚠️ Arquivo de credenciais não encontrado em: ${credsFile}`);
        }
      } catch (err) {
        logger.warn(`⚠️ Erro ao verificar credenciais: ${err.message}`);
      }

      startHeartbeat();
    }

    if (connection === "close") {
      // Atualizar estado de conexão imediatamente
      global.isWhatsAppConnected = false;
      global.sock = null;
      global.whatsappUser = null; // Limpar usuário quando desconectado
      // NÃO limpar currentPairingCode aqui - pode ser necessário para reconexão
      // global.currentQR = null; // Manter QR/código para possível reconexão
      
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const uptime = lastConnected
        ? ((Date.now() - lastConnected) / 60000).toFixed(1)
        : "0";

      logger.warn(`🔴 Conexão encerrada. Motivo: ${reason || "desconhecido"}`);
      logger.warn(`🔴 WhatsApp desconectado após ${uptime} minutos online.`);
      logger.info('🔴 WhatsApp desconectado. Tentando reconectar...');

      // Tratamento específico para códigos de erro
      if (reason === DisconnectReason.loggedOut || reason === 401) {
        logger.error("🚫 Sessão encerrada ou inválida. Será necessário novo código de pareamento. Limpando credenciais e tentando reconectar...");
        // Limpar credenciais antigas antes de reconectar
        // Isso força o Baileys a gerar um novo código de pareamento
        await clearAuthState();
        // Aguardar um pouco antes de reconectar para garantir que os arquivos foram deletados
        setTimeout(() => {
          reconnect();
        }, 1000);
      } else if (reason === 515 || reason === 428) {
        logger.warn(`⚠️ Código de erro ${reason} detectado. Tentando reconectar em 5s...`);
        setTimeout(() => {
          reconnect();
        }, 5000);
      } else {
        // Tentativa automática de reconexão para outros erros
        logger.info("🔄 Tentando reconectar em 5s...");
        setTimeout(() => {
          reconnect();
        }, 5000);
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

  // 🔄 Watchdog: Monitora o status e força reset se ficar muito tempo desconectado
  // Inicializar apenas uma vez (usar flag global para evitar múltiplos intervals)
  if (!global.watchdogInterval) {
    logger.info("🔄 Iniciando watchdog de reconexão automática (verificação a cada 30s)");
    
    global.watchdogInterval = setInterval(async () => {
      const now = Date.now();
      const logger = P({ level: "info" });

      // Se está conectado, atualiza o timestamp
      if (global.isWhatsAppConnected && global.sock?.ws?.readyState === 1) {
        global.lastConnectedAt = now;
        return;
      }

      // Se está desconectado há mais de 3 minutos, tenta restart automático
      const lastCheck = global.lastConnectedAt || global.lastAttemptAt;
      const diff = now - lastCheck;
      
      if (diff > 3 * 60 * 1000) { // 3 minutos
        logger.warn(`⚠️ WhatsApp inativo há mais de ${Math.floor(diff / 60000)} minutos. Reiniciando conexão automaticamente...`);
        global.lastAttemptAt = now;
        
        try {
          await restartWhatsAppConnection();
        } catch (err) {
          logger.error("❌ Falha ao reiniciar automaticamente:", err.message);
        }
      }
    }, 30 * 1000); // checa a cada 30 segundos
  }

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
    global.whatsappUser = null; // Limpar usuário quando desconectado
    global.currentQR = null;
    global.currentQRTimestamp = null;
    global.currentPairingCode = null;
    
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
  restartWhatsAppConnection,
};
