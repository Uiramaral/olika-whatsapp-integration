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

  const FORCE_CLEAR = process.env.FORCE_CLEAR_AUTH_STATE === 'true';
  if (FORCE_CLEAR) {
    logger.warn('⚠️ Limpando sessão antiga...');
    const files = await fs.readdir(SESSION_PATH).catch(() => []);
    for (const file of files) await fs.unlink(path.join(SESSION_PATH, file)).catch(() => {});
  }

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);

  logger.info(`📱 Iniciando WhatsApp para número ${phone}`);

  sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    browser: ['OlikaDashboard', 'Chrome', '10.0'], // nome visível no WhatsApp
    syncFullHistory: true,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    connectTimeoutMs: 60_000,
    mobile: false, // importante: companion mode
    auth: state,
    // ⚙️ novo parâmetro força comportamento Android Companion
    userAgent: {
      platform: 'ANDROID',
      releaseChannel: 'RELEASE',
      osVersion: '13',
      device: 'Pixel 7 Pro',
      manufacturer: 'Google',
      buildNumber: 'TP1A.220624.021',
      mcc: '724',
      mnc: '005',
      localeLanguageIso6391: 'pt',
      localeCountryIso31661Alpha2: 'BR',
    },
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
            const phoneNumber = global.currentWhatsAppPhone || phoneForPairing;
            const formattedPhone = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
            logger.info(`📲 Número formatado para pareamento: ${formattedPhone}`);
            const code = await sock.requestPairingCode(formattedPhone);
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
