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
const logger = require('../config/logger');
const { OpenAI } = require('openai');
const { extractDataForAI } = require('../utils/ai_processor');
const { getContentType } = require('@whiskeysockets/baileys');

// Configurações
const BASE_AUTH_DIR = path.resolve(__dirname, "..", "..", "auth_info_baileys");
const CONFIG_FILE = path.join(BASE_AUTH_DIR, "session_config.json");
const WEBHOOK_URL = process.env.WEBHOOK_URL || "https://devpedido.menuolika.com.br/api/whatsapp/webhook";

// ✅ NOVO: Variáveis para multi-instância
const CLIENT_ID = process.env.CLIENT_ID;

// 🚨 Configurações de Controle de IA
const AI_STATUS_URL = process.env.AI_STATUS_URL;
const WH_API_TOKEN = process.env.WH_API_TOKEN;
const STATUS_CACHE_TTL = 30; // 🚨 NOVO: Cache de 30 segundos

// 🤖 Configurações da OpenAI
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5-nano'; // Modelo de custo otimizado
const OPENAI_TIMEOUT = parseInt(process.env.OPENAI_TIMEOUT) * 1000 || 30000;

// 🎭 Contexto Estático (Persona da IA)
const AI_SYSTEM_PROMPT = process.env.AI_SYSTEM_PROMPT || "Você é um assistente profissional da Olika, otimizado para custo. Sua análise é baseada APENAS no texto que você recebe. Se houver mídia que não pôde ser processada, avise o usuário educadamente.";

// 📋 Contexto Dinâmico (URL para buscar dados do cliente)
const CUSTOMER_CONTEXT_URL = process.env.CUSTOMER_CONTEXT_URL;

// Inicialização da OpenAI (para o GPT-5-nano ou modelo configurado)
const openai = new OpenAI({ 
    apiKey: process.env.OPENAI_API_KEY,
    timeout: OPENAI_TIMEOUT
});

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

/**
 * Busca contexto dinâmico do cliente no Laravel para injeção no prompt
 * @param {string} phoneNumber - Número de telefone do cliente (apenas dígitos)
 * @returns {Promise<string>} String formatada com contexto do cliente ou string vazia
 */
const getCustomerContext = async (phoneNumber) => {
    if (!CUSTOMER_CONTEXT_URL || !WH_API_TOKEN) {
        logger.warn("❌ CUSTOMER_CONTEXT_URL não configurada. Contexto dinâmico desabilitado.");
        return "";
    }

    try {
        const response = await axios.post(CUSTOMER_CONTEXT_URL, {
            phone: phoneNumber
        }, {
            headers: {
                'X-API-Token': WH_API_TOKEN,
                'Content-Type': 'application/json'
            },
            timeout: 3000 // Timeout mais curto para não atrasar a resposta
        });

        const context = response.data;
        
        // Se não houver cliente, retornar vazio
        if (!context.has_customer) {
            return "";
        }

        // Formatar contexto de forma concisa
        let contextString = `[CONTEXTO DO CLIENTE: Nome: ${context.name || 'Cliente'}`;
        
        if (context.last_order) {
            contextString += `, Último Pedido: #${context.last_order}`;
            if (context.last_order_status) {
                contextString += ` (Status: ${context.last_order_status})`;
            }
        }
        
        if (context.total_orders > 0) {
            contextString += `, Total de Pedidos: ${context.total_orders}`;
        }
        
        if (context.loyalty_points !== null && context.loyalty_points > 0) {
            contextString += `, Pontos de Fidelidade: ${context.loyalty_points}`;
        }
        
        contextString += "]";
        
        return contextString;
        
    } catch (error) {
        logger.error(`❌ Falha ao buscar contexto do cliente no Laravel: ${error.message}`);
        // Em caso de falha, continuar sem contexto (não bloquear a IA)
        return "";
    }
};

/**
 * Consulta o Laravel para verificar se a IA está habilitada (COM CACHE).
 * @param {string} senderJid - O JID (número) do remetente.
 * @returns {Promise<boolean>} True se a IA deve responder, False caso contrário.
 */
const checkAiStatus = async (senderJid) => {
    const cacheKey = `ai_status_${senderJid}`;
    const cachedStatus = msgRetryCounterCache.get(cacheKey);

    // 1. Cache Hit
    if (cachedStatus !== undefined) {
        logger.info(`⚡ Cache HIT para status da IA: ${senderJid} -> ${cachedStatus ? 'enabled' : 'disabled'}`);
        return cachedStatus;
    }

    if (!AI_STATUS_URL || !WH_API_TOKEN) {
        logger.warn("❌ Configurações AI_STATUS_URL/WH_API_TOKEN ausentes. IA Desabilitada.");
        return false; 
    }

    try {
        const phoneNumber = senderJid.replace(/@.*$/, '').replace(/\D/g, '');

        // 2. Chamada POST para o Laravel
        const response = await axios.post(AI_STATUS_URL, {
            phone: phoneNumber 
        }, {
            headers: {
                'X-API-Token': WH_API_TOKEN,
                'Content-Type': 'application/json'
            },
            timeout: 5000 
        });

        const isEnabled = response.data.status === 'enabled';
        
        // 3. Cache Miss: Salva no cache antes de retornar
        msgRetryCounterCache.set(cacheKey, isEnabled, STATUS_CACHE_TTL);
        
        if (isEnabled) {
            logger.info(`✅ IA habilitada para ${phoneNumber}`);
        } else {
            logger.info(`🚫 IA desabilitada para ${phoneNumber} (${response.data.reason || 'Global_Kill_Switch'})`);
        }
        
        return isEnabled;
        
    } catch (error) {
        logger.error(`❌ Falha na comunicação com o Laravel para status da IA: ${error.message}`);
        // Política de segurança: Falha na comunicação = IA desligada.
        return false;
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
      
      axios.post(WEBHOOK_URL, { 
        client_id: CLIENT_ID, // ✅ NOVO: Multi-instância
        type: 'connection_update', 
        instance_phone: currentPhone, 
        status: 'CONNECTED' 
      }).catch(() => {});
    }

    if (connection === "close") {
      isSocketConnected = false;
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      
      consecutiveFailures++; // 👈 INCREMENTA A FALHA
      console.log(`🔴 Desconectado (${reason}). Tentativa ${consecutiveFailures}/${MAX_FAILURES}.`);

      // 🔔 Webhook de Status
      axios.post(WEBHOOK_URL, { 
        client_id: CLIENT_ID, // ✅ NOVO: Multi-instância
        type: 'connection_update', 
        instance_phone: currentPhone, 
        status: 'DISCONNECTED' 
      }).catch(() => {});


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

  // Eventos Mantidos - Orquestração Completa de IA
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const incomingMessage = messages[0];
    
    // 🔍 LOG DE DEBUG - SEMPRE LOGAR PRIMEIRO
    const senderJid = incomingMessage.key.remoteJid;
    const fromMe = incomingMessage.key.fromMe;
    
    logger.info(`📩 [DEBUG INICIAL] Mensagem upsert recebida`, {
      fromMe: fromMe,
      remoteJid: senderJid,
      hasMessage: !!incomingMessage.message,
      messageType: incomingMessage.message ? Object.keys(incomingMessage.message)[0] : 'none',
      timestamp: new Date().toISOString()
    });
    
    // Filtro essencial para não processar status ou mensagens próprias
    if (fromMe || !incomingMessage.message) {
      logger.info(`⏭️ [FILTRO 1] Ignorada: fromMe=${fromMe}, hasMessage=${!!incomingMessage.message}`);
      return;
    }
    
    // 🚨 FILTRO: Ignorar broadcasts, newsletters, grupos e status
    if (!senderJid) return;
    if (senderJid.endsWith('@broadcast')) return;
    if (senderJid.endsWith('@newsletter')) return;
    if (senderJid.endsWith('@g.us')) return; // grupos
    if (senderJid === 'status@broadcast') return;
    
    // 🚨 LOG DO NÚMERO DO REMETENTE
    const senderPhone = senderJid.replace(/@.*$/, '').replace(/\D/g, '');
    logger.info(`📞 [FILTRO 2] Mensagem válida de: ${senderPhone}`);
    
    // 🚨 1. VERIFICAÇÃO DE STATUS (COM CACHE)
    logger.info(`🔍 Verificando status da IA para ${senderPhone}...`);
    const aiShouldRespond = await checkAiStatus(senderJid);

    if (!aiShouldRespond) {
        logger.info(`🚫 IA desabilitada para ${senderJid} (Controlado pelo Laravel). Ignorando.`);
        // Se a IA está desligada, você pode adicionar um Webhook aqui para logar a mensagem no Laravel ou deixar que um atendente manual trate.
        // Envia webhook apenas para LOG
        const text = incomingMessage.message?.conversation || 
                     incomingMessage.message?.extendedTextMessage?.text || 
                     '[Mensagem sem texto]';
        
        // 💡 Adiciona o tipo de mensagem para o Laravel decidir a ação (ex: transferência humana para imagens/vídeos)
        const messageType = getContentType(incomingMessage.message) || 'unknown';
        
        // Webhook para LOG no Laravel
        logger.info(`📡 Enviando webhook para Laravel (IA desabilitada): ${WEBHOOK_URL}`);
        axios.post(WEBHOOK_URL, {
            client_id: CLIENT_ID, // ✅ NOVO: Multi-instância
            phone: senderJid.replace("@s.whatsapp.net", ""),
            instance_phone: currentPhone,
            message: text,
            ai_disabled: true,
            message_type: messageType 
        }).catch((e) => {
          logger.error('❌ Erro ao enviar webhook para Laravel:', e.message);
          logger.error('📋 Detalhes:', { url: WEBHOOK_URL, data: { phone: senderJid } });
        });
        return; 
    }
    
    // 2. PROCESSO DE ORQUESTRAÇÃO DE IA
    logger.info(`✅ IA habilitada para ${senderJid}. Iniciando Orquestração de IA...`);
    
    try {
        // Extrai dados e processa áudio/pdf (chamada condicional a Whisper)
        const { payload } = await extractDataForAI(incomingMessage);
        
        // 🎭 CONTEXTO ESTÁTICO: Persona da IA (da variável de ambiente)
        const systemPrompt = AI_SYSTEM_PROMPT;
        
        // 📋 CONTEXTO DINÂMICO: Busca dados do cliente no Laravel
        const phoneNumber = senderJid.replace(/@.*$/, '').replace(/\D/g, '');
        const dynamicContext = await getCustomerContext(phoneNumber);
        
        // Construir prompt do usuário com contexto dinâmico
        let finalUserPrompt = payload;
        if (dynamicContext) {
            finalUserPrompt = `${dynamicContext}\n\n[Mensagem do Usuário]: ${payload}`;
        }
        
        const contentForAI = [
            { role: 'system', content: systemPrompt }, // Persona da IA
            { role: 'user', content: finalUserPrompt } // Contexto + Mensagem do usuário
        ];
        
        // 3. CHAMADA FINAL PARA O GPT (modelo configurado)
        const response = await openai.chat.completions.create({
            model: OPENAI_MODEL,
            messages: contentForAI,
        });

        const replyText = response.choices[0].message.content;

        // 4. RESPOSTA AO USUÁRIO (A função sendMessage agora é robusta)
        await sendMessage(senderJid, replyText);
        logger.info(`✅ Resposta da IA enviada para ${senderJid}.`);
        
        // 5. NOTIFICAR LARAVEL (para o admin receber alerta da mensagem)
        const text = incomingMessage.message?.conversation || 
                     incomingMessage.message?.extendedTextMessage?.text || 
                     '[Mensagem sem texto]';
        const messageType = getContentType(incomingMessage.message) || 'unknown';
        axios.post(WEBHOOK_URL, {
            client_id: CLIENT_ID,
            phone: senderJid.replace('@s.whatsapp.net', ''),
            instance_phone: currentPhone,
            message: text,
            ai_disabled: false,
            message_type: messageType
        }).catch((e) => logger.warn('⚠️ Erro ao notificar Laravel após resposta IA:', e.message));

    } catch (error) {
        logger.error(`❌ ERRO NO FLUXO DE ORQUESTRAÇÃO: ${error.message}`);
        try {
            // A chamada sendMessage é mais robusta, mas ainda pode lançar erro.
            await sendMessage(senderJid, "Desculpe, a análise de IA falhou. Por favor, tente novamente mais tarde.");
        } catch (sendError) {
            logger.error(`❌ Erro ao enviar mensagem de erro: ${sendError.message}`);
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
    
    // 🚨 AJUSTE DE ROBUSTEZ: Captura erros de envio
    try {
        const cleanPhone = phone.replace(/\D/g, "");
        const checkJid = cleanPhone.includes("@s.whatsapp.net") ? cleanPhone : `${cleanPhone}@s.whatsapp.net`;
        const [result] = await globalSock.onWhatsApp(checkJid);
        
        if (!result?.exists) throw new Error("Número inválido no WhatsApp");
        
        const sent = await globalSock.sendMessage(result.jid, { text: message });
        
        return { success: true, messageId: sent.key.id };
    } catch (e) {
        // Loga o erro, mas permite que o fluxo externo continue sem quebrar o listener
        logger.error(`❌ ERRO ao enviar mensagem para ${phone}: ${e.message}`);
        throw new Error(`Falha no envio da mensagem: ${e.message}`); 
    }
};
const isConnected = () => isSocketConnected;
const getCurrentPhone = () => currentPhone;

module.exports = { sendMessage, startSock, isConnected, getCurrentPhone, forceLogout };