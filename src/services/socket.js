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
const crypto = require("crypto");
const logger = require('../config/logger');
const { extractDataForAI } = require('../utils/ai_processor');
const { getContentType, extractMessageContent } = require('@whiskeysockets/baileys');

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
const AI_SYSTEM_PROMPT = process.env.AI_SYSTEM_PROMPT || "Você é o atendente virtual do estabelecimento.";

// 📋 Contexto Dinâmico (URL para buscar dados do cliente)
const CUSTOMER_CONTEXT_URL = process.env.CUSTOMER_CONTEXT_URL;

// 🤖 Atendimento por IA no Laravel (o Laravel decide o provedor: DeepSeek/Gemini)
const IA_RESPONDER_URL = process.env.IA_RESPONDER_URL
  || (WEBHOOK_URL ? WEBHOOK_URL.replace('/webhook', '/ia/responder') : null);

const msgRetryCounterCache = new NodeCache();

// 🔁 Cache de idempotência de envio: a mesma chave não deve gerar duas entregas.
const idempotencyCache = new NodeCache({ stdTTL: 600, maxKeys: 2000 });

// 🛡️ Cache de mensagens enviadas programaticamente pelo gateway (distinção de ecos fromMe).
const systemSentCache = new NodeCache({ stdTTL: 600, maxKeys: 5000 });

// ⏱️ Contador de timeouts de ack: o primeiro é tolerado; o segundo força recuperação.
const ackTimeoutCounter = new NodeCache({ stdTTL: 600 });

// 📦 Store de mensagens para o getMessage (retry de entrega do WhatsApp).
// Sem devolver a mensagem original, o WhatsApp não consegue retentar o envio e o
// remetente vê "Aguardando mensagem. Essa ação pode levar alguns instantes."
const messageStore = new NodeCache({ stdTTL: 3600, maxKeys: 5000, useClones: false });
// Chave (key) da mensagem original, usada para responder citando no WhatsApp.
const messageKeyStore = new NodeCache({ stdTTL: 3600, maxKeys: 5000, useClones: false });
// Controle para não consultar/reenviar pre-keys a cada mensagem (evita roundtrip por envio)
const preKeyCheckCache = new NodeCache({ stdTTL: 600 });
// Indexa SOMENTE pelo id: o retry do WhatsApp pode referenciar a mensagem com
// outra forma de JID (ex.: @lid) diferente da usada no envio (@s.whatsapp.net).
const buildMessageKey = (key) => (key && key.id ? key.id : null);
const storeMessage = (key, message) => {
  const storeKey = buildMessageKey(key);
  if (storeKey && message) {
    messageStore.set(storeKey, message);
    messageKeyStore.set(storeKey, key);
  }
};
const getStoredMessage = (key) => {
  const storeKey = buildMessageKey(key);
  return storeKey ? messageStore.get(storeKey) : undefined;
};

const ehMensagemDoSistema = (messageId) => {
  if (!messageId) return false;
  const idStr = String(messageId);
  return Boolean(systemSentCache.get(idStr) || /^OLK[A-F0-9]{17,}$/i.test(idStr));
};

const ehJidIndividualValido = (jid) => {
  if (!jid || typeof jid !== 'string') return false;
  if (jid === 'status@broadcast') return false;
  if (jid.endsWith('@broadcast') || jid.endsWith('@newsletter') || jid.endsWith('@g.us')) return false;
  return true;
};

const desempacotarConteudoMensagem = (rawMessage) => {
  if (!rawMessage || typeof rawMessage !== 'object') return rawMessage;

  let atual = typeof extractMessageContent === 'function'
    ? (extractMessageContent(rawMessage) || rawMessage)
    : rawMessage;

  for (let i = 0; i < 6 && atual && typeof atual === 'object'; i += 1) {
    if (atual.deviceSentMessage?.message) {
      atual = atual.deviceSentMessage.message;
    } else if (atual.ephemeralMessage?.message) {
      atual = atual.ephemeralMessage.message;
    } else if (atual.viewOnceMessage?.message) {
      atual = atual.viewOnceMessage.message;
    } else if (atual.viewOnceMessageV2?.message) {
      atual = atual.viewOnceMessageV2.message;
    } else if (atual.viewOnceMessageV2Extension?.message) {
      atual = atual.viewOnceMessageV2Extension.message;
    } else if (atual.documentWithCaptionMessage?.message) {
      atual = atual.documentWithCaptionMessage.message;
    } else {
      break;
    }

    if (typeof extractMessageContent === 'function') {
      atual = extractMessageContent(atual) || atual;
    }
  }

  return atual;
};

// Prévia textual para webhook/histórico. Nunca inclui base64 nem binário.
const previewTextoMensagem = (incomingMessage, isFromMe = false) => {
  const raw = incomingMessage?.message ?? incomingMessage ?? {};
  const msg = desempacotarConteudoMensagem(raw) || raw || {};
  const acaoMasc = isFromMe ? 'enviado' : 'recebido';
  const acaoFem = isFromMe ? 'enviada' : 'recebida';

  const captionImagem = String(msg.imageMessage?.caption || '').trim();
  if (msg.imageMessage) {
    return captionImagem ? `[Imagem ${acaoFem}] ${captionImagem}` : `[Imagem ${acaoFem}]`;
  }
  if (msg.audioMessage) {
    return isFromMe ? '[🎵 Áudio enviado]' : '[🎵 Mensagem de Áudio]';
  }
  if (msg.videoMessage) {
    const captionVideo = String(msg.videoMessage.caption || '').trim();
    return captionVideo ? `[🎬 Vídeo ${acaoMasc}] ${captionVideo}` : `[🎬 Vídeo ${acaoMasc}]`;
  }
  if (msg.documentMessage) {
    const nomeDoc = String(msg.documentMessage.fileName || '').trim();
    const captionDoc = String(msg.documentMessage.caption || '').trim();
    const baseDoc = nomeDoc ? `[📄 Documento ${acaoMasc}: ${nomeDoc}]` : `[📄 Documento ${acaoMasc}]`;
    return captionDoc ? `${baseDoc} ${captionDoc}` : baseDoc;
  }
  if (msg.stickerMessage) {
    return isFromMe ? '[Figurinha enviada]' : '[Figurinha recebida]';
  }
  if (msg.locationMessage || msg.liveLocationMessage) {
    const loc = msg.locationMessage || msg.liveLocationMessage;
    const descLoc = String(loc?.name || loc?.address || '').trim();
    return descLoc ? `[📍 Localização ${acaoFem}] ${descLoc}` : `[📍 Localização ${acaoFem}]`;
  }
  if (msg.contactMessage || msg.contactsArrayMessage) {
    const nomeContato = String(msg.contactMessage?.displayName || msg.contactsArrayMessage?.displayName || '').trim();
    return nomeContato ? `[👤 Contato ${acaoMasc}: ${nomeContato}]` : `[👤 Contato ${acaoMasc}]`;
  }
  return msg.conversation
    || msg.extendedTextMessage?.text
    || msg.editedMessage?.message?.conversation
    || msg.editedMessage?.message?.extendedTextMessage?.text
    || (msg.orderMessage ? '[🛒 Pedido do Catálogo WhatsApp]' : '[Mensagem sem texto]');
};

let globalSock = null;
let isSocketConnected = false;
let currentPhone = null;
let disconnectWebhookTimer = null;

// 🔥 Contador de falhas e limite
let consecutiveFailures = 0;
const MAX_FAILURES = 5;

// 🆕 Flag para evitar reconexões duplicadas e controlar estado de pareamento
let isConnecting = false;
let isPairingInProgress = false;

// 🔁 Reconexão controlada: um timer por vez, geração do socket e backoff.
// A geração impede que eventos de um socket antigo derrubem o socket novo.
let reconnectTimer = null;
let socketGeneration = 0;
let reconnectAttempts = 0;
let manualStop = false;
let lastDisconnectInfo = null;
let baileysVersion = null;
const RECONNECT_BASE_MS = parseInt(process.env.RECONNECT_BASE_MS, 10) || 3000;
const RECONNECT_MAX_MS = parseInt(process.env.RECONNECT_MAX_MS, 10) || 60000;
const WATCHDOG_INTERVAL_MS = parseInt(process.env.WATCHDOG_INTERVAL_MS, 10) || 60000;

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

// ⏱️ Timeout (ms) do POST para o Laravel (turno da IA). Cobre principal + fallback com ferramentas.
const IA_RESPONSE_TIMEOUT_MS = parseInt(process.env.IA_RESPONSE_TIMEOUT_MS, 10) || 60000;

// 🩹 Mensagem presa: o servidor cobra o ACK de uma mensagem que não conseguimos
// descriptografar e derruba o stream a cada ~50 min. Guardamos o nó bruto e
// liberamos a mensagem na próxima reentrega (ela já está perdida; o ACK só
// destrava o servidor). Exige o patch de ACK aplicado na imagem.
const patchAckAplicado = (() => {
  try {
    const dirBaileys = path.dirname(require.resolve('@whiskeysockets/baileys'));
    const arquivoRecv = path.join(dirBaileys, 'Socket', 'messages-recv.js');
    return fs.existsSync(arquivoRecv) && fs.readFileSync(arquivoRecv, 'utf8').includes('[OLIKA PATCH]');
  } catch {
    return false;
  }
})();

const DEBUG_RAW_MESSAGES = process.env.DEBUG_RAW_MESSAGES === 'true';
const ACK_STUCK_MESSAGES = patchAckAplicado
  && !['false', '0', 'off'].includes(String(process.env.ACK_STUCK_MESSAGES || '').toLowerCase());
const RAW_MESSAGE_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const RAW_MESSAGE_CACHE_MAX = 5000;
const STUCK_ID_TTL_MS = 6 * 60 * 60 * 1000;
const rawMessageCache = new Map(); // id -> { node, at }
const stuckMessageIds = new Map(); // id -> { at, motivo }

logger.info(`🧩 [Baileys] Patch de ACK: ${patchAckAplicado ? 'aplicado' : 'AUSENTE'}`);
if (!patchAckAplicado) {
  logger.warn('⚠️ [Baileys] Patch de ACK ausente na imagem; a liberação automática de mensagem presa fica desativada.');
}
logger.info(`🩹 [ACK] Liberação de mensagem presa: ${ACK_STUCK_MESSAGES ? 'ativa' : 'desativada'}${DEBUG_RAW_MESSAGES ? ' | log bruto ativo' : ''}.`);

const softRestartCooldown = new NodeCache();
const pendingAcks = new Map(); // messageId -> { timeout, jid }

// Última mensagem recebida por contato: usada para marcar leitura quando um
// atendente humano responde pela Central.
const ultimasRecebidasPorJid = new Map(); // jid -> { id, at }
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
    const timeouts = (ackTimeoutCounter.get('ack_timeout_count') || 0) + 1;
    ackTimeoutCounter.set('ack_timeout_count', timeouts);
    logger.warn(`⏱️ [Envio] Sem confirmação (ack) para ${key.remoteJid} id=${key.id} (timeout ${timeouts}).`);

    // O primeiro timeout é tolerado: reiniciar com o socket conectado pode
    // reenviar a mesma mensagem e duplicá-la no WhatsApp. A recuperação só
    // ocorre se a sessão estiver desconectada ou se houver um segundo timeout.
    if (!isSocketConnected || timeouts >= 2) {
      ackTimeoutCounter.del('ack_timeout_count');
      logger.warn('♻️ [Envio] Disparando recuperação após timeout de ack.');
      softRestart('send-ack-timeout');
    } else {
      logger.warn('⏱️ [Envio] Primeiro timeout com socket conectado; aguardando confirmação antes de reiniciar.');
    }
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
  ackTimeoutCounter.del('ack_timeout_count');
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
  reconnectAttempts,
  lastDisconnect: lastDisconnectInfo,
  authDir: BASE_AUTH_DIR,
});

// Limpa os caches de diagnóstico (nós brutos e ids presos).
const limparCachesDiagnostico = () => {
  const agora = Date.now();
  for (const [id, item] of rawMessageCache) {
    if (agora - item.at > RAW_MESSAGE_CACHE_TTL_MS) rawMessageCache.delete(id);
  }
  for (const [id, item] of stuckMessageIds) {
    if (agora - item.at > STUCK_ID_TTL_MS) stuckMessageIds.delete(id);
  }
};

setInterval(limparCachesDiagnostico, 10 * 60 * 1000).unref();

// Registra o diagnóstico de mensagens brutas e a liberação de mensagem presa.
// - CB:message: guarda o nó por id (antes da descriptografia) e libera ids presos.
// - CB:stream:error: extrai o id do ACK cobrado e tenta liberar imediatamente.
const registrarDiagnosticoRaw = (sock) => {
  try {
    const ws = sock?.ws;
    if (!ws || typeof ws.on !== 'function') return;

    ws.on('CB:message', (node) => {
      const id = node?.attrs?.id;
      if (!id) return;

      rawMessageCache.set(id, { node, at: Date.now() });
      if (rawMessageCache.size > RAW_MESSAGE_CACHE_MAX) {
        const maisAntigo = rawMessageCache.keys().next().value;
        if (maisAntigo) rawMessageCache.delete(maisAntigo);
      }

      if (DEBUG_RAW_MESSAGES) {
        logger.info(`📥 [RAW] id=${id} from=${node.attrs.from || 'n/d'} type=${node.attrs.type || 'n/d'} participant=${node.attrs.participant || 'n/d'}`);
      }

      if (ACK_STUCK_MESSAGES && stuckMessageIds.has(id)) {
        const meta = stuckMessageIds.get(id);
        logger.warn(`🩹 [ACK] Tentando liberar mensagem presa id=${id} from=${node.attrs.from || 'n/d'} type=${node.attrs.type || 'n/d'} (${meta?.motivo || 'stream:error'}).`);
        try {
          Promise.resolve(sock.sendMessageAck(node))
            .then(() => {
              stuckMessageIds.delete(id);
              logger.warn(`🩹 [ACK] Mensagem presa liberada id=${id} from=${node.attrs.from || 'n/d'} type=${node.attrs.type || 'n/d'}. Se for um cliente, peça para reenviar.`);
            })
            .catch((e) => {
              logger.warn(`⚠️ [ACK] Falha ao liberar ${id}; tentarei na próxima reentrega: ${e.message}`);
            });
        } catch (e) {
          logger.warn(`⚠️ [ACK] sendMessageAck indisponível para ${id}: ${e.message}`);
        }
      }
    });

    if (typeof ws.prependListener === 'function') {
      ws.prependListener('CB:stream:error', (node) => {
        const filhos = Array.isArray(node?.content) ? node.content : [];
        const ackNode = filhos.find((c) => c?.tag === 'ack') || filhos[0] || null;
        const id = ackNode?.attrs?.id || null;
        if (!id) return;

        const tipo = ackNode?.attrs?.type || null;
        stuckMessageIds.set(id, { at: Date.now(), motivo: `stream:error${tipo ? ` (${tipo})` : ''}` });
        if (stuckMessageIds.size > 100) {
          const maisAntigo = stuckMessageIds.keys().next().value;
          if (maisAntigo) stuckMessageIds.delete(maisAntigo);
        }
        logger.warn(`🧩 [ACK] Servidor cobrando ACK da mensagem id=${id}${tipo ? ` type=${tipo}` : ''}. ${ACK_STUCK_MESSAGES ? 'Liberando...' : 'ACK_STUCK_MESSAGES está desligado.'}`);

        if (ACK_STUCK_MESSAGES) {
          const emCache = rawMessageCache.get(id);
          if (emCache?.node) {
            logger.warn(`🩹 [ACK] Tentativa imediata de liberar id=${id} from=${emCache.node.attrs?.from || 'n/d'}.`);
            try {
              Promise.resolve(sock.sendMessageAck(emCache.node)).catch((e) => {
                logger.warn(`⚠️ [ACK] Falha na liberação imediata de ${id}: ${e.message}`);
              });
            } catch (e) {
              logger.warn(`⚠️ [ACK] sendMessageAck indisponível para ${id}: ${e.message}`);
            }
          }
        }
      });
    }
  } catch (e) {
    logger.warn(`⚠️ [ACK] Não foi possível registrar o diagnóstico de stream: ${e.message}`);
  }
};

// Agenda uma única reconexão, ignorando timers de sockets que já foram trocados.
const scheduleReconnect = (delayMs, motivo = '') => {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const generation = socketGeneration;
  const delay = Math.max(0, delayMs);

  logger.warn(`🔄 [Conexão] Reconectando em ${(delay / 1000).toFixed(1)}s${motivo ? ` (${motivo})` : ''}...`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (generation !== socketGeneration) return; // uma conexão mais nova já assumiu
    if (!isSocketConnected && currentPhone) {
      startSock(currentPhone).catch((e) => {
        isConnecting = false;
        global.isConnecting = false;
        logger.error(`❌ [Conexão] Falha ao reconectar: ${e.message}`);
      });
    }
  }, delay);
};

// Vigia: se o WebSocket morrer sem emitir "close", reinicia a sessão.
setInterval(() => {
  if (!isSocketConnected || !globalSock || manualStop || isSoftRestarting) return;

  try {
    const ws = globalSock.ws;
    if (ws && typeof ws.isOpen === 'boolean' && !ws.isOpen) {
      logger.warn('⚠️ [Watchdog] WebSocket fechado com sessão marcada como conectada; reiniciando.');
      softRestart('watchdog-ws');
    }
  } catch (e) {
    logger.warn(`⚠️ [Watchdog] Falha ao inspecionar o socket: ${e.message}`);
  }
}, WATCHDOG_INTERVAL_MS).unref();

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
      const phone = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).phone;
      if (phone) return phone;
    }
  } catch (e) {
    logger.warn(`⚠️ [Auth] Falha ao ler session_config.json: ${e.message}`);
  }

  // Fallback: se o session_config.json não estiver no volume (ex.: volume
  // montado na pasta da sessão, e não na pasta pai), procura a pasta mais
  // recente com creds.json e recria o config. Evita STANDBY após deploy.
  try {
    const pastas = fs.readdirSync(BASE_AUTH_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const creds = path.join(BASE_AUTH_DIR, d.name, 'creds.json');
        try {
          return fs.existsSync(creds) ? { phone: d.name, mtime: fs.statSync(creds).mtimeMs } : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);

    if (pastas.length > 0) {
      const phone = pastas[0].phone;
      saveConfig(phone);
      logger.info(`🔐 [Auth] session_config.json ausente; reutilizando a sessão existente ${phone}.`);
      return phone;
    }
  } catch (e) {
    logger.warn(`⚠️ [Auth] Falha ao procurar sessão existente: ${e.message}`);
  }

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
      timeout: 8000
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

const invalidarCacheStatusIa = (...jids) => {
  const chaves = new Set();
  jids.filter(Boolean).forEach((jid) => {
    const str = String(jid);
    chaves.add(`ai_status_${str}`);
    const digits = str.replace(/@.*$/, '').replace(/\D/g, '');
    if (digits) {
      chaves.add(`ai_status_${digits}@s.whatsapp.net`);
      variacoesNumeroWhatsApp(digits).forEach((v) => {
        chaves.add(`ai_status_${v}@s.whatsapp.net`);
      });
    }
  });
  chaves.forEach((chave) => msgRetryCounterCache.del(chave));
};

const resolverContatoDoEvento = async (key) => {
  const senderJidRaw = key?.remoteJid;
  if (!ehJidIndividualValido(senderJidRaw)) {
    return null;
  }

  let senderJid = senderJidRaw;
  let senderIsAlternativeId = false;

  if (senderJidRaw.endsWith('@lid')) {
    const resolvedJid = (await resolveLidToPn(senderJidRaw)) || pnJidFromKey(key);
    if (resolvedJid) {
      logger.info(`🗺️ [LID] Resolvido ${senderJidRaw} → ${resolvedJid}`);
      senderJid = resolvedJid;

      const lidPuro = senderJidRaw.split('@')[0];
      const cleanPhonePuro = resolvedJid.split('@')[0];
      const syncLidUrl = WEBHOOK_URL.replace('/webhook', '/sync-lid');

      logger.info(`🗺️ [LID Sync Express] Sincronizando vínculo: LID ${lidPuro} <-> Telefone ${cleanPhonePuro}`);
      axios.post(syncLidUrl, {
        client_id: CLIENT_ID,
        lid: lidPuro,
        phone: cleanPhonePuro,
        token: WH_API_TOKEN
      }, {
        headers: {
          'X-API-Token': WH_API_TOKEN
        }
      }).catch((e) => logger.error(`❌ [LID Sync Express] Erro ao sincronizar LID: ${e.message}`));
    } else {
      logger.warn(`⚠️ [LID] Não mapeado: ${senderJidRaw}.`);
      senderIsAlternativeId = true;
      senderJid = senderJidRaw;
    }
  }

  if (!ehJidIndividualValido(senderJid)) {
    return null;
  }

  const phone = senderJid.replace(/@.*$/, '').replace(/\D/g, '');
  return {
    rawJid: senderJidRaw,
    jid: senderJid,
    phone,
    isAlternativeId: senderIsAlternativeId,
  };
};

const FROM_ME_STUB_TYPES = new Set([
  'protocolMessage',
  'senderKeyDistributionMessage',
  'fastRatchetKeySenderKeyDistributionMessage',
  'messageContextInfo',
  'deviceListMetadata',
  'keyExchangeMessage',
  'reactionMessage',
  'pollUpdateMessage',
  'pinInChatMessage',
  'keepInChatMessage',
  'bcallMessage',
]);

const tratarMensagemHumanaExterna = async (incomingMessage, upsertType) => {
  const messageId = incomingMessage?.key?.id || null;
  const senderJidRaw = incomingMessage?.key?.remoteJid;

  if (upsertType && upsertType !== 'notify') {
    logger.info(`⏭️ [fromMe] Evento histórico ignorado (type=${upsertType}, id=${messageId}).`);
    return;
  }

  if (!incomingMessage?.message) {
    return;
  }

  if (ehMensagemDoSistema(messageId)) {
    logger.info(`⏭️ [fromMe] Eco programático do sistema ignorado (${messageId}).`);
    return;
  }

  if (!ehJidIndividualValido(senderJidRaw)) {
    logger.info(`⏭️ [fromMe] Conversa não individual ignorada (${senderJidRaw}).`);
    return;
  }

  const conteudoDesempacotado = desempacotarConteudoMensagem(incomingMessage.message);
  if (!conteudoDesempacotado || typeof conteudoDesempacotado !== 'object') {
    return;
  }

  const messageType = getContentType(conteudoDesempacotado) || '';
  if (
    FROM_ME_STUB_TYPES.has(messageType) ||
    conteudoDesempacotado.reactionMessage ||
    conteudoDesempacotado.protocolMessage ||
    conteudoDesempacotado.senderKeyDistributionMessage ||
    conteudoDesempacotado.pollUpdateMessage ||
    conteudoDesempacotado.pinInChatMessage
  ) {
    logger.info(`⏭️ [fromMe] Evento técnico/reação ignorado (${messageType}) para ${senderJidRaw}.`);
    return;
  }

  const textoResumo = previewTextoMensagem({ message: conteudoDesempacotado }, true);
  if (!textoResumo || textoResumo === '[Mensagem sem texto]' || !String(textoResumo).trim()) {
    logger.info(`⏭️ [fromMe] Mensagem sem conteúdo textual/mídia válida ignorada (${messageType}) para ${senderJidRaw}.`);
    return;
  }

  const contato = await resolverContatoDoEvento(incomingMessage.key);
  if (!contato || !contato.phone) {
    logger.info(`⏭️ [fromMe] Destinatário inválido ou não individual após resolução (${senderJidRaw}).`);
    return;
  }

  invalidarCacheStatusIa(contato.rawJid, contato.jid);

  const webhookFromMePayload = {
    client_id: CLIENT_ID,
    phone: contato.jid,
    is_lid: contato.jid.endsWith('@lid'),
    is_alternative_id: contato.isAlternativeId,
    instance_phone: currentPhone,
    message: textoResumo,
    from_me: true,
    origem: 'humano',
    message_type: messageType || 'unknown',
    push_name: null,
    message_id: messageId,
    token: WH_API_TOKEN
  };

  logger.info(`📡 [WEBHOOK fromMe] Encaminhando resposta humana externa ao Laravel`, {
    phone: webhookFromMePayload.phone,
    messageType: webhookFromMePayload.message_type,
    messageId
  });

  axios.post(WEBHOOK_URL, webhookFromMePayload, {
    headers: {
      'X-API-Token': WH_API_TOKEN,
      'Content-Type': 'application/json'
    },
    timeout: 5000
  })
    .then(() => logger.info(`✅ [WEBHOOK fromMe] Registrado no Laravel (${messageId})`))
    .catch((e) => logger.error(`❌ [WEBHOOK fromMe] Erro ao enviar ao Laravel: ${e.message}`));
};

// --- Função Core: Start do Socket ---
const startSock = async (phoneOverride = null) => {
  // Cancela reconexões pendentes e invalida eventos de sockets antigos.
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  manualStop = false;
  const generation = ++socketGeneration;

  const phoneToUse = phoneOverride || loadConfig(); // Sem fallback para .env

  if (!phoneToUse) {
    console.log("⚠️ MODO STANDBY: Nenhum número configurado. Aguardando POST /connect.");
    globalSock = null;
    isSocketConnected = false;
    currentPhone = null;
    isConnecting = false;
    global.isConnecting = false;
    return null;
  }

  if (currentPhone !== phoneToUse) {
    currentPhone = phoneToUse;
    saveConfig(currentPhone);
  }

  isConnecting = true;
  global.isConnecting = true;

  const sessionPath = path.join(BASE_AUTH_DIR, currentPhone);
  if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });

  if (generation !== socketGeneration) return null;

  const arquivosSessao = (() => {
    try { return fs.readdirSync(sessionPath).length; } catch { return 0; }
  })();
  logger.info(`🔐 [Auth] Sessão em ${sessionPath} (${arquivosSessao} arquivo(s)).`);
  if (arquivosSessao === 0) {
    logger.warn('⚠️ [Auth] Pasta de sessão vazia. Sem volume persistente, todo deploy exigirá novo pareamento.');
  }

  // A versão do WhatsApp Web muda pouco; busca uma vez por processo e evita
  // que uma falha de rede impeça a criação do socket.
  if (!baileysVersion) {
    try {
      ({ version: baileysVersion } = await fetchLatestBaileysVersion());
    } catch (e) {
      logger.warn(`⚠️ [Baileys] Falha ao buscar versão (${e.message}); usando a versão padrão da biblioteca.`);
    }
  }
  const version = baileysVersion;

  if (generation !== socketGeneration) return null;

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  if (generation !== socketGeneration) return null;

  if (globalSock) { try { globalSock.end(); } catch { } }

  console.log(`🚀 Iniciando Socket para: ${currentPhone} (v${(version || []).join(".") || 'padrão'})`);

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
    keepAliveIntervalMs: 25000,
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

  // Diagnóstico de mensagens brutas + liberação de mensagem presa (ACK).
  registrarDiagnosticoRaw(sock);

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
    // Ignora eventos de um socket que já foi substituído.
    if (generation !== socketGeneration) return;

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
      reconnectAttempts = 0;
      lastDisconnectInfo = null;

      // Cancela webhook pendente de desconexão se reconectou dentro da janela de debounce
      if (disconnectWebhookTimer) {
        clearTimeout(disconnectWebhookTimer);
        disconnectWebhookTimer = null;
      }

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
      const motivoReal = lastDisconnect?.error?.message
        || lastDisconnect?.error?.output?.payload?.message
        || null;
      const noDoErro = lastDisconnect?.error?.data || null;
      const tagDoErro = noDoErro?.tag || null;

      lastDisconnectInfo = {
        code: reason ?? null,
        message: motivoReal,
        tag: tagDoErro,
        ackId: noDoErro?.attrs?.id || null,
        at: new Date().toISOString(),
      };

      logger.warn(`📉 [Conexão] Fechada (${reason ?? 'n/d'})${motivoReal ? `: ${motivoReal}` : ''}${lastDisconnectInfo.ackId ? ` | id=${lastDisconnectInfo.ackId}` : ''}`);

      if (manualStop) {
        manualStop = false;
        logger.info('⏹️ [Conexão] Fechamento manual; reconexão automática desativada.');
        return;
      }

      // "Stream Errored (conflict)" pode vir com code 401, mas NÃO é logout:
      // significa que outra conexão está usando as mesmas credenciais. Apagar
      // a sessão aqui destrói uma sessão válida e força um novo pareamento.
      const ehConflito = /conflict/i.test(motivoReal || '') || tagDoErro === 'conflict';
      if (ehConflito) {
        logger.error('🚨 [Conexão] Conflito de sessão: outra conexão está usando as mesmas credenciais. Sessão preservada; não vou apagar as credenciais.');
        axios.post(WEBHOOK_URL, {
          type: 'shutdown_alert',
          instance_phone: currentPhone,
          reason: 'CONNECTION_CONFLICT'
        }).catch(() => { });
        scheduleReconnect(300000, 'conflito de sessão');
        return;
      }

      // Erros comuns e esperados durante pareamento e restarts do WhatsApp Web (Meta)
      const isTransientOrPairing = [500, 515, 408, 428, 503].includes(reason) || isPairingInProgress || !sock.authState.creds.registered;

      if (isTransientOrPairing) {
        if (reason === 500 && /ack/i.test(motivoReal || '')) {
          logger.warn('⚠️ [Baileys] Stream derrubado por falta de ACK (bug conhecido da lib). O patch de ACK deve evitar este ciclo.');
        }
        console.log(`⚠️ Desconexão transitória ou de pareamento (${reason}${motivoReal ? ` - ${motivoReal}` : ''}). Mantendo credenciais.`);
      } else {
        consecutiveFailures++;
        console.log(`🔴 Desconectado (${reason}${motivoReal ? ` - ${motivoReal}` : ''}). Falhas consecutivas: ${consecutiveFailures}/${MAX_FAILURES}.`);
      }

      // Webhook de Status para o Laravel com debounce (8s) para amortecer reconexões transitórias
      if (disconnectWebhookTimer) {
        clearTimeout(disconnectWebhookTimer);
      }
      disconnectWebhookTimer = setTimeout(() => {
        if (!isSocketConnected) {
          axios.post(WEBHOOK_URL, {
            client_id: CLIENT_ID,
            type: 'connection_update',
            instance_phone: currentPhone,
            status: 'DISCONNECTED'
          }).catch(() => { });
        }
      }, 8000);

      // Outra instância assumiu a sessão: não brigar por ela em loop.
      if (reason === DisconnectReason.connectionReplaced) {
        logger.error('🚨 [Conexão] Sessão assumida por outra instância (440). Aguardando 90s antes de tentar novamente.');
        axios.post(WEBHOOK_URL, {
          type: 'shutdown_alert',
          instance_phone: currentPhone,
          reason: 'CONNECTION_REPLACED'
        }).catch(() => { });
        scheduleReconnect(90000, 'connectionReplaced');
        return;
      }

      // LOGOUT MANUAL DETECTADO (401) OU LIMITE DE FALHAS CONSECUTIVAS EM PRODUÇÃO
      if (reason === DisconnectReason.loggedOut || consecutiveFailures >= MAX_FAILURES) {        if (disconnectWebhookTimer) {
          clearTimeout(disconnectWebhookTimer);
          disconnectWebhookTimer = null;
        }
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
        reconnectAttempts = 0;
        isConnecting = false;
        isPairingInProgress = false;

        if (reason === DisconnectReason.loggedOut) {
          console.log("🚫 Logout pelo celular. Entrando em modo STANDBY.");
          removeConfig();
        } else {
          console.log("🔄 Reset automático executado. Aguardando novo comando /connect.");
        }
      } else {
        // Backoff exponencial com jitter: 3s, 6s, 12s... até 60s.
        // Em um ciclo normal (abriu e caiu depois de muito tempo) a tentativa
        // volta a zero no "open", então a primeira reconexão continua em ~3s.
        const tentativa = reconnectAttempts;
        reconnectAttempts += 1;
        const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, Math.min(tentativa, 5)));
        const delay = base + Math.floor(Math.random() * 500);
        scheduleReconnect(delay, `tentativa ${tentativa + 1}`);
      }
    }
  });

  // Eventos Mantidos - Orquestração Completa de IA e detecção de envio humano externo
  sock.ev.on("messages.upsert", async ({ messages, type: upsertType }) => {
    for (const incomingMessage of (messages || [])) {
      await (async () => {
        if (!incomingMessage?.key) {
          return;
        }

        // 🔍 LOG DE DEBUG - SEMPRE LOGAR PRIMEIRO (antes de qualquer filtro)
        const senderJidRaw = incomingMessage.key.remoteJid;
        const fromMeRaw = incomingMessage.key.fromMe;
        const messageId = incomingMessage.key.id;

        const tipoBruto = incomingMessage.message ? Object.keys(incomingMessage.message)[0] : 'none';
        logger.info(`📩 [DEBUG INICIAL] id=${messageId || 'n/d'} from=${senderJidRaw || 'n/d'} fromMe=${!!fromMeRaw} type=${tipoBruto}`, {
          upsertType: upsertType || 'unknown',
          hasMessage: !!incomingMessage.message,
          timestamp: new Date().toISOString()
        });

        // 📦 Guarda no store para o getMessage (retry/descriptografia)
        storeMessage(incomingMessage.key, incomingMessage.message);

        if (fromMeRaw) {
          await tratarMensagemHumanaExterna(incomingMessage, upsertType);
          return;
        }

        // Filtro essencial para ignorar eventos recebidos sem corpo
        if (!incomingMessage.message) {
          logger.info(`⏭️ [FILTRO 1] Ignorada: fromMe=${fromMeRaw}, hasMessage=${!!incomingMessage.message}`);
          return;
        }

        // 🚫 Filtro de Mensagens Técnicas / Protocolo / Reações do WhatsApp:
        // Ignora eventos que não representam mensagens reais enviadas por um ser humano:
        // protocolMessage (exclusão, sincronização, chaves), senderKeyDistributionMessage (chaves E2EE),
        // reactionMessage (reação com emoji), deviceSentMessage, etc.
        const rawMessageType = getContentType(incomingMessage.message) || '';
        const internalProtocolTypes = [
          'protocolMessage',
          'senderKeyDistributionMessage',
          'fastRatchetKeySenderKeyDistributionMessage',
          'messageContextInfo',
          'deviceSentMessage',
          'deviceListMetadata',
          'keyExchangeMessage',
          'reactionMessage',
          'pollUpdateMessage',
          'keepInChatMessage',
          'bcallMessage'
        ];

        if (
          internalProtocolTypes.includes(rawMessageType) ||
          incomingMessage.message?.reactionMessage ||
          incomingMessage.message?.protocolMessage ||
          incomingMessage.message?.senderKeyDistributionMessage ||
          incomingMessage.message?.deviceSentMessage
        ) {
          logger.info(`⏭️ [FILTRO PROTOCOLO] Mensagem técnica/interna do WhatsApp (${rawMessageType}) de ${senderJidRaw}. Ignorando silenciosamente.`);
          return;
        }

        // 🗺️ RESOLUÇÃO DE LID e descarte de grupos/broadcasts/newsletters/status
        const contato = await resolverContatoDoEvento(incomingMessage.key);
        if (!contato) {
          logger.info(`⏭️ [FILTRO 2] Contato ignorado (grupo/status/newsletter/inválido): ${senderJidRaw}`);
          return;
        }

        const senderJid = contato.jid;
        const senderIsAlternativeId = contato.isAlternativeId;
        const senderPhone = contato.phone;
        if (incomingMessage.key?.id) {
          ultimasRecebidasPorJid.set(senderJid, { id: incomingMessage.key.id, at: Date.now() });
        }
        logger.info(`📞 [FILTRO 3] Mensagem válida de: ${senderPhone} (JID: ${senderJid})`);

    // Encaminhamento paralelo (n8n) removido: o fluxo é exclusivamente o oficial (Laravel).

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
      const text = previewTextoMensagem(incomingMessage);

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
        message_id: incomingMessage.key.id, // ID único para deduplicação
        token: WH_API_TOKEN
      };
      logger.info(`📡 [WEBHOOK] Enviando para Laravel (IA desabilitada)`, { url: WEBHOOK_URL, phone: webhookPayload.phone });
      axios.post(WEBHOOK_URL, webhookPayload, {
        headers: {
          'X-API-Token': WH_API_TOKEN,
          'Content-Type': 'application/json'
        },
        timeout: 5000
      })
        .then(() => logger.info(`✅ [WEBHOOK] Enviado com sucesso para Laravel`))
        .catch((e) => logger.error('❌ [WEBHOOK] Erro ao enviar para Laravel:', e.message));
      return;
    }

    // 2. PROCESSO DE ORQUESTRAÇÃO DE IA
    logger.info(`✅ IA habilitada para ${senderJid}. Iniciando Orquestração de IA...`);

    // 🚨 Notificar Laravel da mensagem com IA ativa (para salvar no banco ANTES da resposta)
    const textPreview = previewTextoMensagem(incomingMessage);
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
      message_id: incomingMessage.key.id, // ID único para deduplicação
      token: WH_API_TOKEN
    };
    logger.info(`📡 [WEBHOOK] Enviando para Laravel (IA habilitada - pré-processamento)`, { url: WEBHOOK_URL, phone: webhookPayloadAi.phone });
    axios.post(WEBHOOK_URL, webhookPayloadAi, {
      headers: {
        'X-API-Token': WH_API_TOKEN,
        'Content-Type': 'application/json'
      },
      timeout: 5000
    })
      .then(() => logger.info(`✅ [WEBHOOK] Pré-notificação enviada com sucesso para Laravel`))
      .catch((e) => logger.warn('⚠️ [WEBHOOK] Erro ao pré-notificar Laravel:', e.message));

    try {
      // 🛒 Se for pedido do Catálogo do WhatsApp (orderMessage), tenta enriquecer com getOrderDetails
      if (incomingMessage.message?.orderMessage) {
        const oMsg = incomingMessage.message.orderMessage;
        if (oMsg.orderId && oMsg.token && typeof sock.getOrderDetails === 'function') {
          try {
            logger.info(`🛒 [Catálogo] Consultando itens da ordem ${oMsg.orderId} no WhatsApp...`);
            const detailsPromise = sock.getOrderDetails(oMsg.orderId, oMsg.token);
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3500));
            incomingMessage._orderDetails = await Promise.race([detailsPromise, timeoutPromise]);
            logger.info(`✅ [Catálogo] Ordem ${oMsg.orderId} carregada com ${incomingMessage._orderDetails?.products?.length || 0} produto(s).`);
          } catch (eOrder) {
            logger.warn(`⚠️ [Catálogo] getOrderDetails indisponível ou expirou: ${eOrder.message}. Usando dados resumidos.`);
          }
        }
      }

      // Extrai dados (texto/pdf/imagem/vídeo/pedido). Áudio NÃO é transcrito (tratado abaixo).
      const { payload, type, image, imageError } = await extractDataForAI(incomingMessage);
      const temImagem = !!(image && image.base64);

      // Se não houver texto, imagem extraída nem erro de imagem a notificar, não envia para a IA.
      if ((!payload || !payload.trim()) && !temImagem && !(type === 'imagem' && imageError)) {
        logger.info(`⏭️ [IA] Mensagem de ${senderJid} sem conteúdo processável (tipo: ${type}${imageError ? `, imagem: ${imageError}` : ''}). Ignorando.`);
        return;
      }

      // 🎵 ÁUDIO: a IA não ouve. Orienta o cliente a enviar texto ou solicitar atendente.
      if (type === 'audio') {
        try {
          await sendMessage(senderJid, 'Sou um atendente virtual com inteligência artificial e ainda não consigo ouvir áudios. Se puder, escreva sua mensagem em texto ou peça para falar com nossa equipe. 🙏');
        } catch (e) {
          logger.error(`❌ [Áudio] Falha ao avisar o cliente: ${e.message}`);
        }

        return; // não chama a IA
      }

      // 🤖 Texto/PDF/imagem/vídeo/documento: quem orquestra e notifica o painel/admin é o Laravel
      const phoneNumber = senderJid.replace(/@.*$/, '').replace(/\D/g, '');
      const responderUrl = IA_RESPONDER_URL;

      if (!responderUrl || !WH_API_TOKEN) {
        throw new Error('IA_RESPONDER_URL/WH_API_TOKEN ausentes.');
      }

      const iaPayload = {
        mensagem: payload || (type === 'imagem' ? '[Imagem recebida]' : ''),
        telefone: phoneNumber,
        message_id: incomingMessage.key.id,
        message_type: messageTypePreview
      };
      if (temImagem) {
        iaPayload.imagem_base64 = image.base64;
        iaPayload.imagem_mime = image.mime;
      }
      if (imageError) {
        iaPayload.imagem_erro = imageError;
      }

      // Nunca loga o base64: apenas o tipo e o resultado da extração.
      logger.info(`📤 [IA] Enviando para o Laravel (tipo=${type}, imagem=${temImagem ? 'sim' : 'não'}${imageError ? `, erro=${imageError}` : ''})`);

      const iaResponse = await axios.post(responderUrl, iaPayload, {
        headers: {
          'X-API-Token': WH_API_TOKEN,
          'Content-Type': 'application/json'
        },
        timeout: IA_RESPONSE_TIMEOUT_MS
      });

      const replyText = iaResponse.data && iaResponse.data.resposta;
      // Mensagens extras (ex.: código PIX copia-e-cola) enviadas soltas, para copiar facilmente.
      const extrasResposta = Array.isArray(iaResponse.data.extras) ? iaResponse.data.extras : [];

      if (iaResponse.data.allowlist === false) {
        logger.info(`🚫 [IA] Sem resposta para ${senderJid} (allowlist).`);
        return;
      }

      // Só considera "sem resposta" quando não há texto NEM extras (ex.: resposta com só o PIX).
      if (!replyText && extrasResposta.length === 0) {
        logger.info(`🚫 [IA] Sem resposta para ${senderJid} (indisponível).`);
        return;
      }

      if (replyText) {
        await sendMessage(senderJid, replyText);
        logger.info(`✅ Resposta da IA (Laravel) enviada para ${senderJid}`);
      }

      // Intervalo humanizado entre as mensagens do mesmo turno (uma de cada vez, ~5s por padrão).
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

      // O agente leu e respondeu: marca a mensagem recebida como lida (check azul para o cliente).
      await marcarComoLida(senderJid, [incomingMessage.key.id]);

    } catch (error) {
      logger.error(`❌ ERRO NO FLUXO DE ORQUESTRAÇÃO: ${error.message}`);

      try {
        await sendMessage(senderJid, "Desculpe, não consegui processar sua mensagem agora. Por favor, tente novamente em instantes ou aguarde um retorno da nossa equipe. 🙏");
      } catch (sendError) {
        logger.error(`❌ Erro ao enviar mensagem de erro: ${sendError.message}`);
      }
    }
      })();
    }
  });
  sock.ev.on("creds.update", saveCreds);

  // ✅ Confirmações de entrega/leitura: libera o monitor de envio travado
  sock.ev.on("messages.update", (updates) => {
    for (const { key } of updates) {
      if (key?.id && pendingAcks.has(key.id)) {
        clearPendingSend(key.id);
        ackTimeoutCounter.del('ack_timeout_count');
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

  manualStop = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  global.isConnecting = false; // ✅ Libera o flag global (permite novo /connect após reset)

  if (globalSock) {
    // Desvincula o aparelho para não deixar dispositivo fantasma na lista do celular.
    // Timeout curto: um socket morto não pode travar o reset.
    if (isSocketConnected) {
      try {
        await Promise.race([
          Promise.resolve(globalSock.logout()),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
      } catch { }
    }
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

// Desconecta a instância. Por padrão mantém o aparelho vinculado (credenciais preservadas).
// Use { unlink: true } para desvincular o aparelho e apagar a sessão (novo pareamento).
const disconnectSock = async ({ unlink = false } = {}) => {
  if (unlink) {
    const result = await forceLogout();
    return {
      success: true,
      message: 'Desconectado e aparelho desvinculado. Chame /connect para um novo pareamento.',
      unlinked: true,
      ...result,
    };
  }

  console.log('🔴 DESCONEXÃO INICIADA! (manter credenciais)');

  manualStop = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  global.isConnecting = false; // ✅ Libera o flag global ao desconectar manualmente

  if (!globalSock) {
    manualStop = false;
    console.warn('⚠️  Socket já está desconectado');
    return { success: true, message: 'Já desconectado', unlinked: false };
  }

  const sock = globalSock;
  try {
    // Fecha a conexão mantendo as credenciais locais.
    try { sock.end(); } catch { }
    try { if (sock.ws) sock.ws.close(); } catch { }

    // Limpar referência global (mas NÃO deletar credenciais)
    globalSock = null;
    isSocketConnected = false;
    console.log('✅ Instância desconectada');

    return {
      success: true,
      message: 'Desconectado (credenciais preservadas).',
      unlinked: false,
    };
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
    try {
      await startSock();
    } catch (e) {
      isConnecting = false;
      global.isConnecting = false;
      logger.error(`❌ [Boot] Falha ao iniciar o socket: ${e.message}`);
    }
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

const marcarComoLida = async (jid, messageIds = []) => {
  const ids = messageIds.filter(Boolean).map(String);
  if (!globalSock || !isSocketConnected || !jid || ids.length === 0) return;
  try {
    await globalSock.readMessages(ids.map((id) => ({ remoteJid: jid, id, fromMe: false })));
    logger.info(`👁️ [Leitura] ${ids.length} mensagem(ns) marcada(s) como lida(s) para ${jid}`);
  } catch (e) {
    logger.warn(`⚠️ [Leitura] Falha ao marcar como lida (${jid}): ${e.message}`);
  }
};

const sendMessage = async (phone, message, options = {}) => {
  if (!globalSock || !isSocketConnected) throw new Error("Offline");

  try {
    const cleanPhone = phone ? String(phone).replace(/\D/g, "") : "";

    // 🛡️ Prevenção contra números sentinelas ou vazios (evita erros Signal no WhatsApp Web)
    if (!cleanPhone || cleanPhone.length < 10 || cleanPhone === '11999999999' || cleanPhone === '5511999999999') {
      logger.warn(`⚠️ [sendMessage] Destinatário inválido ou sentinela ignorado: ${phone}`);
      throw new Error("Número inválido ou sentinela no WhatsApp");
    }

    const idempotencyKey = options?.idempotencyKey ? String(options.idempotencyKey).trim() : "";
    const cacheKey = idempotencyKey || null;

    if (cacheKey) {
      const cached = idempotencyCache.get(cacheKey);
      if (cached) {
        logger.info(`♻️ [Idempotência] Envio deduplicado para ${cleanPhone} (chave ${cacheKey})`);
        return { success: true, messageId: cached.messageId, deduplicated: true };
      }
    }

    // ID determinístico: o mesmo idempotencyKey reutiliza o mesmo messageId;
    // quando ausente, usa prefixo exclusivo OLK para diferenciar ecos fromMe mesmo pós-restart.
    const stableMessageId = cacheKey
      ? 'OLK' + crypto.createHash('sha1').update('olika:' + cacheKey).digest('hex').slice(0, 17).toUpperCase()
      : undefined;
    const outgoingId = stableMessageId
      || ('OLK' + crypto.randomBytes(10).toString('hex').toUpperCase());

    let destinoJid = null;
    for (const variacao of variacoesNumeroWhatsApp(cleanPhone)) {
      const [result] = await globalSock.onWhatsApp(`${variacao}@s.whatsapp.net`);
      if (result?.exists) {
        destinoJid = result.jid;
        break;
      }
    }

    if (!destinoJid) throw new Error("Número inválido no WhatsApp");

    systemSentCache.set(outgoingId, true);
    const sendOptions = { messageId: outgoingId };

    // Resposta citando uma mensagem específica (somente quando solicitado pelo atendente).
    if (options?.quotedId) {
      const quotedKey = messageKeyStore.get(String(options.quotedId));
      const quotedMessage = messageStore.get(String(options.quotedId));
      if (quotedKey && quotedMessage) {
        sendOptions.quoted = { key: quotedKey, message: quotedMessage };
      } else {
        logger.warn(`⚠️ [Citação] Mensagem original não encontrada (${options.quotedId}); enviando sem citação.`);
      }
    }

    const sent = await globalSock.sendMessage(destinoJid, { text: message }, sendOptions);

    if (sent?.key?.id) {
      systemSentCache.set(sent.key.id, true);
    }

    if (cacheKey) {
      idempotencyCache.set(cacheKey, { messageId: sent?.key?.id || outgoingId, em: Date.now() });
    }

    // Resposta humana pela Central: marca como lida a última mensagem recebida do contato.
    if (options?.marcarLeitura) {
      const ultima = ultimasRecebidasPorJid.get(destinoJid);
      if (ultima && Date.now() - ultima.at <= 24 * 60 * 60 * 1000) {
        await marcarComoLida(destinoJid, [ultima.id]);
        ultimasRecebidasPorJid.delete(destinoJid);
      }
    }

    // 📦 Guarda para retry (getMessage) e monitora confirmação de entrega
    storeMessage(sent?.key, sent?.message);
    registerPendingSend(sent?.key);

    return { success: true, messageId: sent.key.id, deduplicated: false };
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

// Encerra o socket sem desvincular o aparelho (usado no SIGTERM/deploy).
const shutdownSocket = async () => {
  manualStop = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const sock = globalSock;
  globalSock = null;
  isSocketConnected = false;
  isConnecting = false;
  global.isConnecting = false;

  if (sock) {
    try { sock.end(); } catch { }
    try { if (sock.ws) sock.ws.close(); } catch { }
  }
};

module.exports = { sendMessage, marcarComoLida, startSock, isConnected, getCurrentPhone, forceLogout, disconnectSock, softRestart, getDiagnostics, shutdownSocket };
