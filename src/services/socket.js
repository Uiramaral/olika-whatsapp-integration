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
// Mesma precedência do app.js: fonte única do token Gateway -> Laravel.
// API_SECRET é o valor que bate com o chave_api; process.env.API_TOKEN fica por último.
const WH_API_TOKEN = process.env.WH_API_TOKEN || process.env.API_SECRET || process.env.API_TOKEN;
const STATUS_CACHE_TTL = 30; // 🚨 NOVO: Cache de 30 segundos

// 🎭 Contexto Estático (Persona da IA) — mantido apenas como referência legada
const AI_SYSTEM_PROMPT = process.env.AI_SYSTEM_PROMPT || "Você é o atendente virtual da Olika.";

// 📋 Contexto Dinâmico (URL para buscar dados do cliente)
const CUSTOMER_CONTEXT_URL = process.env.CUSTOMER_CONTEXT_URL;

// 🤖 Atendimento por IA no Laravel (o Laravel decide o provedor: DeepSeek/Gemini)
const IA_RESPONDER_URL = process.env.IA_RESPONDER_URL
  || (WEBHOOK_URL ? WEBHOOK_URL.replace('/webhook', '/ia/responder') : null);

const msgRetryCounterCache = new NodeCache();

// 📦 Store de mensagens para o getMessage (retry de entrega do WhatsApp).
// Sem devolver a mensagem original, o WhatsApp não consegue retentar o envio e o
// remetente vê "Aguardando mensagem. Essa ação pode levar alguns instantes."
const messageStore = new NodeCache({ stdTTL: 3600, maxKeys: 5000, useClones: false });
// Controle para não consultar/reenviar pre-keys a cada mensagem (evita roundtrip por envio)
const preKeyCheckCache = new NodeCache({ stdTTL: 600 });
// Indexa SOMENTE pelo id: o retry do WhatsApp pode referenciar a mensagem com
// outra forma de JID (ex.: @lid) diferente da usada no envio (@s.whatsapp.net).
const buildMessageKey = (key) => (key && key.id ? key.id : null);
const storeMessage = (key, message) => {
  const storeKey = buildMessageKey(key);
  if (storeKey && message) messageStore.set(storeKey, message);
};
const getStoredMessage = (key) => {
  const storeKey = buildMessageKey(key);
  return storeKey ? messageStore.get(storeKey) : undefined;
};

const adminNotifyCooldownCache = new NodeCache();
// 📲 Notificação ao Administrador (celular que recebe alerta quando um cliente manda msg)
const ADMIN_NOTIFY_PHONE = process.env.ADMIN_NOTIFY_PHONE || '5571981750546';
const ADMIN_NOTIFY_COOLDOWN = parseInt(process.env.ADMIN_NOTIFY_COOLDOWN, 10) || 1800; // 30 minutos de silêncio por cliente

// 💾 Cooldown persistido: sobrevive a reinícios do serviço (o cache em memória não sobrevive).
const ADMIN_COOLDOWN_FILE = path.join(BASE_AUTH_DIR, 'admin_notify_cooldown.json');

const lerCooldownsAdmin = () => {
  try {
    if (fs.existsSync(ADMIN_COOLDOWN_FILE)) {
      return JSON.parse(fs.readFileSync(ADMIN_COOLDOWN_FILE, 'utf8')) || {};
    }
  } catch (e) {
    logger.warn(`⚠️ [Alerta Admin] Falha ao ler cooldown persistido: ${e.message}`);
  }
  return {};
};

const gravarCooldownsAdmin = (mapa) => {
  try {
    fs.writeFileSync(ADMIN_COOLDOWN_FILE, JSON.stringify(mapa), 'utf8');
  } catch (e) {
    logger.warn(`⚠️ [Alerta Admin] Falha ao gravar cooldown persistido: ${e.message}`);
  }
};

// Retorna true quando o contato ainda está em período de silêncio.
const emCooldownAdmin = (chaveContato) => {
  const agora = Date.now();
  const mapa = lerCooldownsAdmin();
  let alterou = false;

  for (const [chave, expiraEm] of Object.entries(mapa)) {
    if (!expiraEm || expiraEm <= agora) {
      delete mapa[chave];
      alterou = true;
    }
  }
  if (alterou) gravarCooldownsAdmin(mapa);

  return Boolean(mapa[chaveContato] && mapa[chaveContato] > agora);
};

const registrarCooldownAdmin = (chaveContato) => {
  const mapa = lerCooldownsAdmin();
  mapa[chaveContato] = Date.now() + (ADMIN_NOTIFY_COOLDOWN * 1000);
  gravarCooldownsAdmin(mapa);
};

let globalSock = null;
let isSocketConnected = false;
let currentPhone = null;

// 🔥 Contador de falhas e limite
let consecutiveFailures = 0;
const MAX_FAILURES = 3;

// 🆕 Flag para evitar reconexões duplicadas e controlar estado de pareamento
let isConnecting = false;
let isPairingInProgress = false;

// 🗺️ Mapa LID → JID real (protocolo WhatsApp LID)
// O WhatsApp usa LIDs (@lid) em vez de JIDs (@s.whatsapp.net) para remetentes externos
// Este mapa é populado via contacts.upsert e usado para resolver o número real
const lidToJidMap = new Map();

// 🔁 Recuperação automática de envios travados / sessão
// Baileys 7.x mudou o comportamento de ACKs de entrega; por padrão o monitor
// automático fica DESLIGADO (0 = desligado) para evitar soft restarts indevidos.
// Reative com SEND_ACK_TIMEOUT_MS=<ms> se quiser o gatilho por ack.
const SEND_ACK_TIMEOUT_MS = parseInt(process.env.SEND_ACK_TIMEOUT_MS, 10) || 0;
const SOFT_RESTART_COOLDOWN_SECONDS = parseInt(process.env.SOFT_RESTART_COOLDOWN_SECONDS, 10) || 300;

// ⏱️ Intervalo humanizado entre as mensagens do mesmo turno do agente (resposta principal + extras).
// Padrão: 5s. Ajustável por IA_MESSAGE_DELAY_MS.
const IA_MESSAGE_DELAY_MS = parseInt(process.env.IA_MESSAGE_DELAY_MS, 10) || 5000;
const delayMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const softRestartCooldown = new NodeCache();
const pendingAcks = new Map(); // messageId -> { timeout, jid }
let isSoftRestarting = false;

const clearPendingSend = (id) => {
  const entry = pendingAcks.get(id);
  if (entry) {
    clearTimeout(entry.timeout);
    pendingAcks.delete(id);
  }
};

const registerPendingSend = (key) => {
  if (SEND_ACK_TIMEOUT_MS <= 0) return;
  if (!key?.id) return;
  clearPendingSend(key.id);
  const timeout = setTimeout(() => {
    pendingAcks.delete(key.id);
    logger.warn(`⏱️ [Envio] Sem confirmação (ack) para ${key.remoteJid} id=${key.id}. Disparando recuperação automática.`);
    softRestart('send-ack-timeout');
  }, SEND_ACK_TIMEOUT_MS);
  pendingAcks.set(key.id, { timeout, jid: key.remoteJid });
};

// Reinício suave: encerra o socket em memória e reconecta com as credenciais atuais
// (sem novo pareamento). Distinto do reset destrutivo (forceLogout/clear-auth).
const softRestart = async (reason = 'manual') => {
  if (isSoftRestarting) {
    logger.warn(`⚠️ [SoftRestart] Já em andamento (motivo ignorado: ${reason}).`);
    return { success: false, message: 'Reinício já em andamento' };
  }
  if (softRestartCooldown.get('cooldown')) {
    logger.warn(`⚠️ [SoftRestart] Em cooldown. Motivo ignorado: ${reason}.`);
    return { success: false, message: 'Em cooldown' };
  }

  const phone = currentPhone || loadConfig();
  if (!phone) {
    logger.warn('⚠️ [SoftRestart] Sem número configurado.');
    return { success: false, message: 'Sem número configurado' };
  }

  isSoftRestarting = true;
  softRestartCooldown.set('cooldown', true, SOFT_RESTART_COOLDOWN_SECONDS);
  logger.warn(`♻️ [SoftRestart] Reiniciando sessão (motivo: ${reason}). Sem novo pareamento.`);

  pendingAcks.forEach((entry) => clearTimeout(entry.timeout));
  pendingAcks.clear();
  if (globalSock) { try { globalSock.end(); } catch { } }
  globalSock = null;
  isSocketConnected = false;
  isConnecting = true;
  global.isConnecting = true;

  setTimeout(async () => {
    try {
      await startSock(phone);
    } catch (e) {
      logger.error(`❌ [SoftRestart] Falha ao reconectar: ${e.message}`);
    } finally {
      isSoftRestarting = false;
    }
  }, 2000);

  return { success: true, message: `Sessão reiniciada (${reason})` };
};

const getDiagnostics = () => ({
  connected: isSocketConnected,
  isConnecting: isConnecting || false,
  isSoftRestarting,
  currentPhone: currentPhone || null,
  pendingAcks: pendingAcks.size,
});

// Extrai o JID de telefone real a partir dos campos alternativos que o Baileys
// expõe nos keys (@lid). Retorna null quando não há telefone disponível.
const pnJidFromKey = (key) => {
  const pn = key?.senderPn || key?.participantPn;
  if (!pn) return null;
  const digits = String(pn).replace(/\D/g, '');
  return digits ? `${digits}@s.whatsapp.net` : null;
};

// Resolve @lid -> telefone. No Baileys 7.x a tradução LID<->PN é interna
// (signalRepository.lidMapping.getPNForLID); usamos o lidToJidMap como cache.
const resolveLidToPn = async (lidJid) => {
  if (!lidJid || !String(lidJid).endsWith('@lid')) return null;
  const cached = lidToJidMap.get(lidJid);
  if (cached) return cached;
  try {
    const pn = await globalSock?.signalRepository?.lidMapping?.getPNForLID?.(lidJid);
    if (pn) {
      const user = String(pn).split('@')[0].split(':')[0];
      const jid = `${user}@s.whatsapp.net`;
      lidToJidMap.set(lidJid, jid);
      logger.info(`🗺️ [LID] getPNForLID ${lidJid} → ${jid}`);
      return jid;
    }
  } catch (e) {
    logger.warn(`⚠️ [LID] Falha no getPNForLID para ${lidJid}: ${e.message}`);
  }
  return null;
};

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

  if (globalSock) { try { globalSock.end(); } catch { } }

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
    // Padrão false: mantém o aparelho recebendo notificações push (recomendação do Baileys).
    // Pode ser reativado via MARK_ONLINE_ON_CONNECT=true sem alterar código.
    markOnlineOnConnect: process.env.MARK_ONLINE_ON_CONNECT === 'true',
    syncFullHistory: false,
    msgRetryCounterCache,
    // Garante pre-keys válidas antes de enviar (evita sessão sem chave → "Aguardando mensagem")
    patchMessageBeforeSending: async (msg) => {
      if (!preKeyCheckCache.get('checked')) {
        preKeyCheckCache.set('checked', true);
        try {
          if (globalSock?.uploadPreKeysToServerIfRequired) {
            await globalSock.uploadPreKeysToServerIfRequired();
          }
        } catch (e) {
          logger.warn(`⚠️ [PreKeys] Falha ao verificar/reenviar pre-keys: ${e.message}`);
        }
      }
      return msg;
    },
    connectTimeoutMs: 90000,
    retryRequestDelayMs: 2000,
    defaultQueryTimeoutMs: 60000,
    // 🔑 CRÍTICO: retorna a mensagem original do store para permitir o retry de
    // entrega do WhatsApp. Sem isso, o remetente vê "Aguardando mensagem".
    getMessage: async (key) => {
      const stored = getStoredMessage(key);
      logger.info(`🔑 [getMessage] ${key?.remoteJid} id=${key?.id} -> ${stored ? 'encontrado' : 'não encontrado'}`);
      return stored;
    },
  });

  // Geração do Código de Pareamento
  if (!sock.authState.creds.registered) {
    isPairingInProgress = true;
    console.log("⏳ Aguardando (3s) para pedir código de pareamento...");
    setTimeout(async () => {
      const cleanPhone = String(currentPhone || '').replace(/\D/g, '');
      if (!cleanPhone) {
        console.error("❌ Telefone inválido para solicitar código de pareamento.");
        return;
      }

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          console.log(`📱 Tentativa ${attempt}/3 de solicitar código para ${cleanPhone}...`);
          const code = await sock.requestPairingCode(cleanPhone);
          console.log(`\n#################################################`);
          console.log(`📠 CÓDIGO (${cleanPhone}): ${code?.match(/.{1,4}/g)?.join("-")}`);
          console.log(`#################################################\n`);
          global.currentPairingCode = code;

          // Timeout para limpar código expirado (5 minutos)
          setTimeout(() => {
            if (global.currentPairingCode === code && !isSocketConnected) {
              console.log("⏰ Código de pareamento expirado. Solicite novo código se necessário.");
              global.currentPairingCode = null;
            }
          }, 5 * 60 * 1000);

          break; // Sucesso, sai do loop
        } catch (err) {
          console.error(`❌ Erro ao pedir código (tentativa ${attempt}/3):`, err.message);
          if (attempt < 3) {
            console.log("🔄 Aguardando 2s antes de tentar novamente...");
            await new Promise(r => setTimeout(r, 2000));
          }
        }
      }
    }, 3000);
  }

  // Monitoramento de Conexão
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.log(`✅ ${currentPhone} CONECTADO!`);
      globalSock = sock;
      isSocketConnected = true;
      isConnecting = false;
      global.isConnecting = false; // ✅ Libera o flag global usado pelo app.js (evita 429 permanente)
      isPairingInProgress = false;
      global.currentPairingCode = null;
      consecutiveFailures = 0;

      // Evita timeouts obsoletos de envios da sessão anterior
      pendingAcks.forEach((entry) => clearTimeout(entry.timeout));
      pendingAcks.clear();

      axios.post(WEBHOOK_URL, {
        client_id: CLIENT_ID,
        type: 'connection_update',
        instance_phone: currentPhone,
        status: 'CONNECTED'
      }).catch(() => { });
    }

    if (connection === "close") {
      isSocketConnected = false;
      isConnecting = false;
      global.isConnecting = false; // ✅ Libera o flag global em qualquer desconexão
      const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;

      // Erros comuns e esperados durante pareamento e restarts do WhatsApp Web
      const isTransientOrPairing = [500, 515, 408, 428].includes(reason) || isPairingInProgress || !sock.authState.creds.registered;

      if (isTransientOrPairing) {
        console.log(`⚠️ Desconexão transitória ou de pareamento (${reason}). Mantendo credenciais.`);
      } else {
        consecutiveFailures++;
        console.log(`🔴 Desconectado (${reason}). Falhas consecutivas: ${consecutiveFailures}/5.`);
      }

      // Webhook de Status para o Laravel
      axios.post(WEBHOOK_URL, {
        client_id: CLIENT_ID,
        type: 'connection_update',
        instance_phone: currentPhone,
        status: 'DISCONNECTED'
      }).catch(() => { });

      // LOGOUT MANUAL DETECTADO (401) OU LIMITE DE 5 FALHAS CONSECUTIVAS EM PRODUÇÃO
      if (reason === DisconnectReason.loggedOut || consecutiveFailures >= 5) {
        console.error("🚨 SESSÃO ENCERRADA (Logout ou Falha Persistente). Resetando credenciais...");

        // Notifica o Laravel
        axios.post(WEBHOOK_URL, {
          type: 'shutdown_alert',
          instance_phone: currentPhone,
          reason: reason === DisconnectReason.loggedOut ? 'LOGGED_OUT' : 'PERSISTENT_FAILURE'
        }).catch(() => { });

        // Limpeza automática da pasta de sessão corrompida
        const sessionPath = path.join(BASE_AUTH_DIR, currentPhone || '');
        if (currentPhone && fs.existsSync(sessionPath)) {
          try {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log("🗑️ Pasta de sessão corrompida/antiga removida com sucesso.");
          } catch (fsErr) {
            console.error("Erro ao deletar pasta de sessão:", fsErr.message);
          }
        }

        globalSock = null;
        global.currentPairingCode = null;
        consecutiveFailures = 0;
        isConnecting = false;
        isPairingInProgress = false;

        if (reason === DisconnectReason.loggedOut) {
          console.log("🚫 Logout pelo celular. Entrando em modo STANDBY.");
          removeConfig();
        } else {
          console.log("🔄 Reset automático executado. Aguardando novo comando /connect.");
        }
      } else {
        // Reconexão suave com debounce de 3 segundos para evitar loops de concorrência
        const phoneToReconnect = currentPhone;
        console.log("🔄 Reconectando socket em 3s...");
        setTimeout(() => {
          if (!isSocketConnected && phoneToReconnect) {
            startSock(phoneToReconnect);
          }
        }, 3000);
      }
    }
  });

  // Eventos Mantidos - Orquestração Completa de IA
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const incomingMessage = messages[0];

    // 🔍 LOG DE DEBUG - SEMPRE LOGAR PRIMEIRO (antes de qualquer filtro)
    const senderJidRaw = incomingMessage.key.remoteJid;
    const fromMeRaw = incomingMessage.key.fromMe;
    const messageId = incomingMessage.key.id;
    
    logger.info(`📩 [DEBUG INICIAL] Mensagem upsert recebida`, {
      fromMe: fromMeRaw,
      remoteJid: senderJidRaw,
      hasMessage: !!incomingMessage.message,
      messageType: incomingMessage.message ? Object.keys(incomingMessage.message)[0] : 'none',
      timestamp: new Date().toISOString()
    });

    // 📦 Guarda no store para o getMessage (retry/descriptografia)
    storeMessage(incomingMessage.key, incomingMessage.message);

    // Filtro essencial para não processar status ou mensagens próprias
    if (fromMeRaw || !incomingMessage.message) {
      logger.info(`⏭️ [FILTRO 1] Ignorada: fromMe=${fromMeRaw}, hasMessage=${!!incomingMessage.message}`);
      return;
    }

    // 🗺️ RESOLUÇÃO DE LID: O WhatsApp usa LIDs no protocolo multi-device
    // Mensagens de números externos chegam com @lid em vez de @s.whatsapp.net
    // Tentamos resolver via mapa; se não encontrado, processamos assim mesmo com log
    let senderJid = senderJidRaw;
    let senderIsAlternativeId = false;
    if (senderJidRaw && senderJidRaw.endsWith('@lid')) {
      const resolvedJid = (await resolveLidToPn(senderJidRaw)) || pnJidFromKey(incomingMessage.key);
      if (resolvedJid) {
        logger.info(`🗺️ [LID] Resolvido ${senderJidRaw} → ${resolvedJid}`);
        senderJid = resolvedJid;
        // ✅ IMPORTANTE: Se já temos o JID resolvido, NÃO enviamos webhook com LID
        // Isso evita duplicatas no banco (uma com LID, outra com JID)
        
        // 🚨 AJUSTE DE TOKEN DEDICADO NO SYNC-LID EXPRESS
        const lidPuro = senderJidRaw.split('@')[0];
        const cleanPhonePuro = resolvedJid.split('@')[0];
        const syncLidUrl = WEBHOOK_URL.replace('/webhook', '/sync-lid');
        
        logger.info(`🗺️ [LID Sync Express] Sincronizando vínculo: LID ${lidPuro} <-> Telefone ${cleanPhonePuro}`);
        axios.post(syncLidUrl, {
          client_id: CLIENT_ID,
          lid: lidPuro,
          phone: cleanPhonePuro,
          token: WH_API_TOKEN // ✅ Injeta no corpo
        }, {
          headers: {
            'X-API-Token': WH_API_TOKEN // ✅ Injeta no Header
          }
        }).catch((e) => logger.error(`❌ [LID Sync Express] Erro ao sincronizar LID: ${e.message}`));
      } else {
        // LID não mapeado ainda — processa assim mesmo, usando o LID como identificador
        // O número no banco será o LID até o contato ser mapeado
        const pushName = incomingMessage.pushName || 'Desconhecido';
        logger.warn(`⚠️ [LID] Não mapeado: ${senderJidRaw} (pushName=${pushName}). Processando com LID.`);
        senderIsAlternativeId = true;
        senderJid = senderJidRaw; // mantém o @lid
      }
    }

    // 🚨 FILTRO: Ignorar broadcasts, newsletters, grupos e status
    // @lid NÃO é mais filtrado — é resolvido acima para o JID real
    if (!senderJid) return;
    if (senderJid.endsWith('@broadcast')) { logger.info(`⏭️ [FILTRO 2] Ignorado @broadcast: ${senderJid}`); return; }
    if (senderJid.endsWith('@newsletter')) { logger.info(`⏭️ [FILTRO 2] Ignorado @newsletter: ${senderJid}`); return; }
    if (senderJid.endsWith('@g.us')) { logger.info(`⏭️ [FILTRO 2] Ignorado @g.us (grupo): ${senderJid}`); return; }
    if (senderJid === 'status@broadcast') { logger.info(`⏭️ [FILTRO 2] Ignorado status@broadcast`); return; }

    // 🚨 LOG DO NÚMERO DO REMETENTE APÓS FILTROS
    const senderPhone = senderJid.replace(/@.*$/, '').replace(/\D/g, '');
    logger.info(`📞 [FILTRO 3] Mensagem válida de: ${senderPhone} (JID: ${senderJid})`);

    // 📲 ALERTA AO ADMINISTRADOR (71981750546) COM JANELA DE SILÊNCIO (COOLDOWN)
    const adminPhoneClean = ADMIN_NOTIFY_PHONE.replace(/\D/g, '');
    const cleanSenderPhone = senderPhone ? senderPhone.replace(/\D/g, '') : '';

    // Evita loop se a mensagem for enviada pelo próprio administrador
    if (adminPhoneClean && cleanSenderPhone && !cleanSenderPhone.endsWith(adminPhoneClean.slice(-8))) {
      // Chave por contato normalizado: o mesmo cliente (número ou LID mapeado) conta como um só.
      const cooldownKey = `admin_notif_${cleanSenderPhone}`;
      const jaNotificado = emCooldownAdmin(cooldownKey) || adminNotifyCooldownCache.get(cooldownKey);

      if (!jaNotificado) {
        // Persiste o cooldown (sobrevive a reinício) e mantém o cache em memória como reforço
        registrarCooldownAdmin(cooldownKey);
        adminNotifyCooldownCache.set(cooldownKey, true, ADMIN_NOTIFY_COOLDOWN);

        const pushName = incomingMessage.pushName || 'Cliente';
        const msgRaw = incomingMessage.message?.conversation ||
                       incomingMessage.message?.extendedTextMessage?.text ||
                       (incomingMessage.message?.imageMessage ? '[📷 Foto/Imagem]' :
                        incomingMessage.message?.audioMessage ? '[🎵 Mensagem de Áudio]' :
                        incomingMessage.message?.documentMessage ? '[📄 Documento]' :
                        '[Mídia/Arquivo]');

        const msgResumo = msgRaw.length > 160 ? msgRaw.substring(0, 157) + '...' : msgRaw;
        const cooldownMin = Math.round(ADMIN_NOTIFY_COOLDOWN / 60);

        const alertaAdmin = `🔔 *Nova mensagem no WhatsApp da Olika*\n\n` +
                            `👤 *Cliente:* ${pushName}${senderIsAlternativeId ? ' (ID alternativo)' : ` (${cleanSenderPhone})`}\n` +
                            `💬 *Mensagem:* "${msgResumo}"\n\n` +
                            `_Próximos avisos deste número silenciados por ${cooldownMin} min._`;

        logger.info(`📲 [Alerta Admin] Notificando ${adminPhoneClean} sobre primeira mensagem de ${cleanSenderPhone}...`);

        // Disparo assíncrono (sem bloquear o processamento da IA ou webhooks)
        sendMessage(adminPhoneClean, alertaAdmin)
          .then(() => logger.info(`✅ [Alerta Admin] Alerta entregue com sucesso para o administrador (${adminPhoneClean})!`))
          .catch((err) => logger.warn(`⚠️ [Alerta Admin] Falha ao enviar alerta para ${adminPhoneClean}: ${err.message}`));
      } else {
        logger.info(`⏳ [Alerta Admin] Mensagem de ${cleanSenderPhone} em período de silêncio (cooldown de ${Math.round(ADMIN_NOTIFY_COOLDOWN / 60)} min ativo).`);
      }
    }

    // 🚨 INTEGRAÇÃO COM N8N: Se N8N_WEBHOOK_URL estiver configurada no Railway (ou via fallback), desvia o fluxo para o n8n
    const n8nUrl = process.env.N8N_WEBHOOK_URL || "https://n8n-production-e19d.up.railway.app/webhook-test/d10aac8e-455d-4345-94a3-54a33bec56ff";
    if (n8nUrl) {
      logger.info(`📡 [N8N] Encaminhando mensagem de ${senderPhone} para o n8n...`);
      
      const deQuem = senderJid ? senderJid.split('@')[0] : '';
      const textoMensagem = incomingMessage.message?.conversation || 
                            incomingMessage.message?.extendedTextMessage?.text || 
                            '[Mídia/Outro]';
        
      const webhookPayload = {
        client_id: CLIENT_ID, // Mantido para referência interna
        instance_phone: currentPhone,
        number: deQuem, // Apenas o número de telefone puro (ex: 5571999999999)
        jid: senderJid, // JID completo caso o n8n precise de @s.whatsapp.net ou @lid
        text: textoMensagem,
        pushName: incomingMessage.pushName || 'Desconhecido',
        message_id: incomingMessage.key.id,
        raw_message: incomingMessage // Mantido para o n8n poder acessar botões, reações, etc. se necessário
      };

      // Dispara para o n8n
      axios.post(n8nUrl, webhookPayload)
        .then(() => logger.info(`🚀 [n8n Webhook] Dados enviados com sucesso para o n8n!`))
        .catch((e) => {
          const status = e.response?.status;
          const statusText = e.response?.statusText;
          const responseData = e.response?.data ? JSON.stringify(e.response.data) : '';
          
          if (status === 404) {
            logger.warn(`⚠️ [n8n Webhook] Erro 404: O n8n não está ouvindo eventos de teste no momento. No painel do n8n, clique em "Listen for test event" (ou "Test step") antes de enviar a mensagem, ou ative (Active) o workflow de produção.`);
          } else {
            logger.error(`❌ [n8n Webhook] Erro ao enviar para o n8n. Status: ${status || 'N/A'} (${statusText || 'N/A'}). Detalhes: ${responseData || e.message}`);
          }
        });
    }

    // 🚨 NOVO: Atualização automática de nome se o pushName for válido e o banco tiver "Cliente"
    const pushNameAtual = incomingMessage.pushName || '';

    // Lista de nomes genéricos que queremos substituir
    const nomesGenericos = ['Cliente', 'Desconhecido', 'unknown', '', null];

    // Se o pushName que veio do WhatsApp for válido (não for genérico)
    if (!nomesGenericos.includes(pushNameAtual)) {
      
      // 📋 Busca o contexto atual do cliente para ver o que está salvo no banco
      getCustomerContext(senderPhone).then(async (dynamicContext) => {
        
        // Verifica se o contexto atual diz que o nome do banco é genérico ou se não tem contexto
        const bancoTemNomeGenerico = nomesGenericos.some(generico => 
          dynamicContext.includes(`Nome: ${generico}`)
        ) || dynamicContext === ""; // Se dynamicContext for vazio, o cliente é novo no banco

        if (bancoTemNomeGenerico) {
          logger.info(`👤 [Auto-Name Update] Nome no banco é genérico, mas WhatsApp trouxe: "${pushNameAtual}". Atualizando Laravel...`);
          
          try {
            const updateNameUrl = WEBHOOK_URL.replace('/webhook', '/update-name');
            const cleanIdentifier = senderJid.split('@')[0];

            // Dispara a atualização direto para o Laravel de forma silenciosa
            await axios.post(updateNameUrl, {
              number: cleanIdentifier,
              name: pushNameAtual,
              token: WH_API_TOKEN
            }, {
              headers: {
                'X-API-Token': WH_API_TOKEN
              },
              timeout: 3000
            });
            
            logger.info(`✅ [Auto-Name Update] Nome do cliente "${pushNameAtual}" atualizado com sucesso no Laravel!`);
          } catch (err) {
            logger.error(`❌ [Auto-Name Update] Falha ao atualizar nome no Laravel: ${err.message}`);
          }
        }
      }).catch((err) => logger.error(`❌ [Auto-Name Update] Erro ao checar contexto: ${err.message}`));
    }


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

      // 💡 Adiciona o tipo de mensagem e pushName para o Laravel
      const messageType = getContentType(incomingMessage.message) || 'unknown';
      const pushName = incomingMessage.pushName || null;

      // Webhook para LOG no Laravel
      const webhookPayload = {
        client_id: CLIENT_ID,
        phone: senderJid,
        is_lid: senderJid.endsWith('@lid'),
        is_alternative_id: senderIsAlternativeId,
        instance_phone: currentPhone,
        message: text,
        ai_disabled: true,
        message_type: messageType,
        push_name: pushName,
        message_id: incomingMessage.key.id // ID único para deduplicação
      };
      logger.info(`📡 [WEBHOOK] Enviando para Laravel (IA desabilitada)`, { url: WEBHOOK_URL, phone: webhookPayload.phone });
      axios.post(WEBHOOK_URL, webhookPayload)
        .then(() => logger.info(`✅ [WEBHOOK] Enviado com sucesso para Laravel`))
        .catch((e) => logger.error('❌ [WEBHOOK] Erro ao enviar para Laravel:', e.message));
      return;
    }

    // 2. PROCESSO DE ORQUESTRAÇÃO DE IA
    logger.info(`✅ IA habilitada para ${senderJid}. Iniciando Orquestração de IA...`);

    // 🚨 Notificar Laravel da mensagem com IA ativa (para salvar no banco ANTES da resposta)
    const textPreview = incomingMessage.message?.conversation ||
      incomingMessage.message?.extendedTextMessage?.text ||
      '[Mensagem sem texto]';
    const messageTypePreview = getContentType(incomingMessage.message) || 'unknown';
    const pushNamePreview = incomingMessage.pushName || null;
    const webhookPayloadAi = {
      client_id: CLIENT_ID,
      phone: senderJid,
      is_lid: senderJid.endsWith('@lid'),
      instance_phone: currentPhone,
      message: textPreview,
      ai_disabled: false,
      message_type: messageTypePreview,
      push_name: pushNamePreview,
      message_id: incomingMessage.key.id // ID único para deduplicação
    };
    logger.info(`📡 [WEBHOOK] Enviando para Laravel (IA habilitada - pré-processamento)`, { url: WEBHOOK_URL, phone: webhookPayloadAi.phone });
    axios.post(WEBHOOK_URL, webhookPayloadAi)
      .then(() => logger.info(`✅ [WEBHOOK] Pré-notificação enviada com sucesso para Laravel`))
      .catch((e) => logger.warn('⚠️ [WEBHOOK] Erro ao pré-notificar Laravel:', e.message));

    try {
      // Extrai dados (texto/pdf/mídia). Áudio NÃO é transcrito (tratado abaixo).
      const { payload, type } = await extractDataForAI(incomingMessage);

      // 🎵 ÁUDIO: a IA não ouve. Notifica o admin (ignorando cooldown) e avisa o cliente.
      if (type === 'audio') {
        const isAdmin = adminPhoneClean && senderPhone && senderPhone.endsWith(adminPhoneClean.slice(-8));

        try {
          await sendMessage(senderJid, 'Sou um atendente virtual com inteligência artificial e ainda não consigo ouvir áudios. Já avisei uma pessoa da equipe da Olika, que vai te responder por aqui. Se puder, escreva sua mensagem em texto. 🙏');
        } catch (e) {
          logger.error(`❌ [Áudio] Falha ao avisar o cliente: ${e.message}`);
        }

        if (!isAdmin && adminPhoneClean) {
          const alertaAudio = `🔔 *Áudio recebido no WhatsApp da Olika*\n\n` +
            `👤 *Cliente:* ${incomingMessage.pushName || 'Cliente'} (${senderPhone})\n` +
            `🎵 _Mensagem de áudio — a IA não transcreve. Atenda manualmente._`;
          sendMessage(adminPhoneClean, alertaAudio)
            .then(() => logger.info('✅ [Áudio] Administrador notificado (ignorando cooldown).'))
            .catch((err) => logger.warn(`⚠️ [Áudio] Falha ao notificar admin: ${err.message}`));
        }

        return; // não chama a IA
      }

      // 📷 MÍDIA (foto/vídeo/documento): notifica o admin (ignorando cooldown) e segue para a IA.
      if (type === 'imagem' || type === 'documento') {
        const isAdminMidia = adminPhoneClean && senderPhone && senderPhone.endsWith(adminPhoneClean.slice(-8));
        if (!isAdminMidia && adminPhoneClean) {
          const rotulo = type === 'imagem' ? 'Imagem/Foto' : 'Documento';
          const alertaMidia = `🔔 *${rotulo} recebido no WhatsApp da Olika*\n\n` +
            `👤 *Cliente:* ${incomingMessage.pushName || 'Cliente'} (${senderPhone})\n` +
            `📎 _A IA não lê este tipo de mídia. Atenda manualmente se necessário._`;
          sendMessage(adminPhoneClean, alertaMidia)
            .then(() => logger.info('✅ [Mídia] Administrador notificado (ignorando cooldown).'))
            .catch((err) => logger.warn(`⚠️ [Mídia] Falha ao notificar admin: ${err.message}`));
        }
        // não retorna: a IA ainda responde com o texto/caption disponível
      }

      // 🤖 Texto/PDF: quem responde é o Laravel (DeepSeek/Gemini)
      const phoneNumber = senderJid.replace(/@.*$/, '').replace(/\D/g, '');
      const responderUrl = IA_RESPONDER_URL;

      if (!responderUrl || !WH_API_TOKEN) {
        throw new Error('IA_RESPONDER_URL/WH_API_TOKEN ausentes.');
      }

      const iaResponse = await axios.post(responderUrl, {
        mensagem: payload,
        telefone: phoneNumber,
        message_id: incomingMessage.key.id
      }, {
        headers: {
          'X-API-Token': WH_API_TOKEN,
          'Content-Type': 'application/json'
        },
        timeout: 25000
      });

      const replyText = iaResponse.data && iaResponse.data.resposta;

      if (!replyText || iaResponse.data.allowlist === false) {
        logger.info(`🚫 [IA] Sem resposta para ${senderJid} (allowlist/indisponível).`);
        return;
      }

      await sendMessage(senderJid, replyText);
      logger.info(`✅ Resposta da IA (Laravel) enviada para ${senderJid}`);

      // Mensagens extras (ex.: código PIX copia-e-cola) enviadas soltas, para copiar facilmente.
      // Intervalo humanizado entre as mensagens do mesmo turno (uma de cada vez, ~5s por padrão).
      const extrasResposta = Array.isArray(iaResponse.data.extras) ? iaResponse.data.extras : [];
      for (const extra of extrasResposta) {
        const textoExtra = extra === null || extra === undefined ? '' : String(extra).trim();
        if (textoExtra !== '') {
          if (IA_MESSAGE_DELAY_MS > 0) {
            await delayMs(IA_MESSAGE_DELAY_MS);
          }
          try {
            await sendMessage(senderJid, textoExtra);
          } catch (e) {
            logger.warn(`⚠️ [IA] Falha ao enviar mensagem extra: ${e.message}`);
          }
        }
      }

    } catch (error) {
      logger.error(`❌ ERRO NO FLUXO DE ORQUESTRAÇÃO: ${error.message}`);
      try {
        await sendMessage(senderJid, "Desculpe, não consegui responder agora. Já avisei a equipe da Olika e logo te retornamos. 🙏");
      } catch (sendError) {
        logger.error(`❌ Erro ao enviar mensagem de erro: ${sendError.message}`);
      }
    }
  });
  sock.ev.on("creds.update", saveCreds);

  // ✅ Confirmações de entrega/leitura: libera o monitor de envio travado
  sock.ev.on("messages.update", (updates) => {
    for (const { key } of updates) {
      if (key?.id && pendingAcks.has(key.id)) {
        clearPendingSend(key.id);
        logger.info(`✅ [Envio] Confirmação recebida para id=${key.id}`);
      }
    }
  });

  // 🗺️ Listener para popular o mapa LID → JID real
  // O WhatsApp usa LIDs no protocolo multi-device. Quando contatos chegam,
  // guardamos o mapeamento LID → JID para resolver mensagens @lid.
  sock.ev.on('contacts.upsert', (contacts) => {
    let novos = 0;
    const syncLidUrl = WEBHOOK_URL.replace('/webhook', '/sync-lid');
    
    for (const contact of contacts) {
      if (contact.lid && contact.id) {
        const lidKey = contact.lid.endsWith('@lid') ? contact.lid : `${contact.lid}@lid`;
        const jidValue = contact.id.endsWith('@s.whatsapp.net') ? contact.id : `${contact.id}@s.whatsapp.net`;
        
        if (!lidToJidMap.has(lidKey)) {
          lidToJidMap.set(lidKey, jidValue);
          novos++;
          
          // 🚨 AJUSTE DE TOKEN DEDICADO NO HANDLE CONTACTS GERAL
          const lidPuro = lidKey.split('@')[0];
          const phonePuro = jidValue.split('@')[0];
          
          axios.post(syncLidUrl, {
            client_id: CLIENT_ID,
            lid: lidPuro,
            phone: phonePuro,
            token: WH_API_TOKEN // ✅ Injeta no corpo
          }, {
            headers: {
              'X-API-Token': WH_API_TOKEN // ✅ Injeta no Header
            }
          }).catch(() => {});
        }
      }
    }
    if (novos > 0) {
      logger.info(`🗺️ [LID MAP & Sync] ${novos} contato(s) mapeados e sincronizados com o Laravel. Total no mapa: ${lidToJidMap.size}`);
    }
  });

  globalSock = sock;
  return sock;
};

// --- Funções de Controle Exportadas ---
const forceLogout = async () => {
  console.log("🚨 RESET MANUAL INICIADO!");

  global.isConnecting = false; // ✅ Libera o flag global (permite novo /connect após reset)

  if (globalSock) {
    try { globalSock.end(); } catch { }
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

// Desconecta a instância sem deletar credenciais
const disconnectSock = async () => {
  console.log("🔴 DESCONEXÃO INICIADA!");

  global.isConnecting = false; // ✅ Libera o flag global ao desconectar manualmente

  if (!globalSock) {
    console.warn('⚠️  Socket já está desconectado');
    return { success: true, message: 'Já desconectado' };
  }

  try {
    // 1. Fazer logout para invalidar a sessão no WhatsApp
    await globalSock.logout();
    console.log('✅ Logout realizado');

    // 2. Fechar conexão
    if (globalSock.ws) {
      globalSock.ws.close();
    }
    globalSock.end();

    // 3. Limpar referência global (mas NÃO deletar credenciais)
    globalSock = null;
    isSocketConnected = false;
    console.log('✅ Instância desconectada completamente');

    return { success: true, message: 'Desconectado com sucesso' };
  } catch (error) {
    console.error(`❌ Erro ao desconectar: ${error.message}`);
    // Forçar limpeza mesmo com erro
    globalSock = null;
    isSocketConnected = false;
    throw error;
  }
};

// Inicialização: Tenta startar, se não tiver config, entra em STANDBY
(async () => {
  setTimeout(async () => {
    await startSock();
  }, 500);
})();

// --- Exportações ---

// Variações do número brasileiro com/sem o 9º dígito (DDI 55 + DDD + assinante).
// O WhatsApp pode ter o contato salvo em um dos formatos; testamos ambos antes de falhar.
const variacoesNumeroWhatsApp = (cleanPhone) => {
  const variacoes = [cleanPhone];

  if (String(cleanPhone).startsWith('55')) {
    // 55 + DDD(2) + 9 + 8 dígitos = 13 → tentar a variação sem o 9º dígito
    if (cleanPhone.length === 13 && cleanPhone[4] === '9') {
      variacoes.push(cleanPhone.slice(0, 4) + cleanPhone.slice(5));
    }
    // 55 + DDD(2) + 8 dígitos = 12 → tentar a variação com o 9º dígito (só celular)
    else if (cleanPhone.length === 12 && ['6', '7', '8', '9'].includes(cleanPhone[4])) {
      variacoes.push(cleanPhone.slice(0, 4) + '9' + cleanPhone.slice(4));
    }
  }

  return variacoes;
};

const sendMessage = async (phone, message) => {
  if (!globalSock || !isSocketConnected) throw new Error("Offline");

  // 🚨 AJUSTE DE ROBUSTEZ: Captura erros de envio
  try {
    const cleanPhone = phone.replace(/\D/g, "");

    let destinoJid = null;
    for (const variacao of variacoesNumeroWhatsApp(cleanPhone)) {
      const [result] = await globalSock.onWhatsApp(`${variacao}@s.whatsapp.net`);
      if (result?.exists) {
        destinoJid = result.jid;
        break;
      }
    }

    if (!destinoJid) throw new Error("Número inválido no WhatsApp");

    const sent = await globalSock.sendMessage(destinoJid, { text: message });

    // 📦 Guarda para retry (getMessage) e monitora confirmação de entrega
    storeMessage(sent?.key, sent?.message);
    registerPendingSend(sent?.key);

    return { success: true, messageId: sent.key.id };
  } catch (e) {
    // Loga o erro, mas permite que o fluxo externo continue sem quebrar o listener
    logger.error(`❌ ERRO ao enviar mensagem para ${phone}: ${e.message}`);
    throw new Error(`Falha no envio da mensagem: ${e.message}`);
  }
};
const isConnected = () => isSocketConnected;
const getCurrentPhone = () => currentPhone;

// 🛡️ Handlers globais para prevenir crash loops no Railway
process.on('uncaughtException', (error) => {
  logger.error('❌ UNCAUGHT EXCEPTION (socket.js):', { message: error.message, stack: error.stack });
});

process.on('unhandledRejection', (reason) => {
  logger.error('❌ UNHANDLED REJECTION (socket.js):', { reason: String(reason) });
});

module.exports = { sendMessage, startSock, isConnected, getCurrentPhone, forceLogout, disconnectSock, softRestart, getDiagnostics };
