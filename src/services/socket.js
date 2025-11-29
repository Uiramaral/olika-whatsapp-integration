require('dotenv').config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const P = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs').promises;
const path = require('path');

// Diretório de sessão persistente (Railway)
const SESSION_BASE_DIR = path.resolve(process.cwd(), 'auth_info_baileys');

// Estado global
let sock;
global.sock = null;
global.isWhatsAppConnected = false;
global.currentWhatsAppPhone = null;
global.whatsappUser = null;
global.currentPairingCode = null;
global.currentQR = null;

// Reiniciar conexão manualmente
async function restartWhatsAppConnection() {
  const logger = P({ level: 'info' });
  try {
    if (global.sock) {
      logger.info('🔁 Encerrando conexão atual antes de reiniciar...');
      await global.sock.logout?.();
      await global.sock.end?.();
      global.sock = null;
      global.isWhatsAppConnected = false;
    }
  } catch (e) {
    logger.warn('⚠️ Erro ao encerrar conexão:', e.message);
  }
  await startSock(global.currentWhatsAppPhone);
}

// Inicializa conexão WhatsApp
async function startSock(whatsappPhone = null) {
  const { version } = await fetchLatestBaileysVersion();
  const logger = P({ level: 'info' });

  const phone = whatsappPhone || process.env.WHATSAPP_PHONE || '5571987019420';
  global.currentWhatsAppPhone = phone;
  const SESSION_PATH = path.resolve(SESSION_BASE_DIR, phone);

  await fs.mkdir(SESSION_PATH, { recursive: true });

  // 🧹 Limpeza forçada de sessão antiga (essencial para pareamento limpo)
  const FORCE_CLEAR = process.env.FORCE_CLEAR_AUTH_STATE === 'true';
  if (FORCE_CLEAR) {
    logger.warn('⚠️ FORCE_CLEAR_AUTH_STATE ativado - Limpando sessão antiga completamente...');
    try {
      const files = await fs.readdir(SESSION_PATH).catch(() => []);
      for (const file of files) {
        const filePath = path.join(SESSION_PATH, file);
        await fs.unlink(filePath).catch(() => {});
      }
      logger.info(`✅ ${files.length} arquivo(s) de sessão removido(s). Nova autenticação será necessária.`);
    } catch (err) {
      logger.error('❌ Erro ao limpar sessão:', err.message);
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);

  logger.info(`📱 Iniciando WhatsApp para número ${phone}`);

  // ⚙️ Configuração de variáveis de ambiente para modo Companion
  process.env.WA_CONNECTION_TYPE = 'companion';
  process.env.WA_ENDPOINT = 'g.whatsapp.net';

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    auth: state,
    mobile: false,
    markOnlineOnConnect: false,
    connectTimeoutMs: 60000,
    syncFullHistory: true,
    generateHighQualityLinkPreview: false,

    // ⚙️ Força modo Companion (aparece como "Ubuntu" no celular)
    browser: ['Ubuntu', 'Ubuntu', '20.04'],
    waWebSocketUrl: 'wss://g.whatsapp.net/ws/chat',
    waWebSocketOptions: {
      family: 4,
      rejectUnauthorized: false
    },
    userAgent: {
      platform: 'LINUX',
      releaseChannel: 'RELEASE',
      osVersion: 'Ubuntu 20.04',
      device: 'Ubuntu',
      manufacturer: 'Canonical',
      buildNumber: '2024.10.1',
      mcc: '724',
      mnc: '005',
      localeLanguageIso6391: 'pt',
      localeCountryIso31661Alpha2: 'BR'
    }
  });

  global.sock = sock;

  const phoneForPairing = phone;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr, pairingCode } = update;
    const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;

    if (qr && !global.currentPairingCode) {
      global.currentQR = qr;
      logger.info('📱 Novo QR Code gerado. Escaneie com o app WhatsApp.');

      setTimeout(async () => {
        try {
          if (sock?.requestPairingCode) {
            logger.info('📞 Solicitando código de pareamento...');
            let phoneNumber = global.currentWhatsAppPhone || phoneForPairing;
            if (!phoneNumber.startsWith('+')) phoneNumber = '+' + phoneNumber; // ✅ sempre adiciona o +
            logger.info(`📲 Número formatado para pareamento: ${phoneNumber}`);
            const code = await sock.requestPairingCode(phoneNumber);
            global.currentPairingCode = code;
            logger.info(`🔢 Código de pareamento: ${code}`);
          }
        } catch (e) {
          logger.error('❌ Falha ao gerar código de pareamento:', e.message);
        }
      }, 2500);
    }

    if (pairingCode) {
      global.currentPairingCode = pairingCode;
      logger.info(`🔢 Código de pareamento (emitido automaticamente): ${pairingCode}`);
    }

    if (connection === 'open') {
      global.isWhatsAppConnected = true;
      global.whatsappUser = sock.user;
      logger.info(`🟢 WhatsApp conectado: ${sock.user?.id}`);
    }

    if (connection === 'close') {
      global.isWhatsAppConnected = false;
      logger.warn(`🔴 Conexão encerrada (${reason}).`);
      if (reason !== DisconnectReason.loggedOut) {
        setTimeout(() => restartWhatsAppConnection(), 10000);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  return sock;
}

function isConnected() {
  return !!global.isWhatsAppConnected;
}

async function sendMessage(number, message) {
  const sock = global.sock;
  if (!sock || !isConnected()) throw new Error('WhatsApp não está conectado');
  if (!number || !message) throw new Error('Número e mensagem são obrigatórios');

  let jid = number.replace(/\D/g, ''); // Remove caracteres não numéricos
  if (!number.includes('@s.whatsapp.net')) {
    jid = `${jid}@s.whatsapp.net`;
  } else {
    jid = number;
  }

  const result = await sock.sendMessage(jid, { text: message });
  return {
    success: true,
    messageId: result?.key?.id,
  };
}

module.exports = { startSock, sendMessage, isConnected, restartWhatsAppConnection };
