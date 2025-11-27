const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const logger = require('../config/logger');
const path = require('path');
const fs = require('fs');

const AUTH_PATH = path.resolve(__dirname, '../../auth_info_baileys');

let sock;

const connectToWhatsApp = async () => {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);

    sock = makeWASocket({
        printQRInTerminal: true,
        auth: state,
        logger: logger, // Passando o Pino logger
        browser: ["Olika Delivery", "Chrome", "1.0.0"],
        connectTimeoutMs: 60000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            logger.info(' QR Code gerado. VERIFIQUE OS LOGS DO RAILWAY.');
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            logger.error(`Conexão fechada. Reconectando: ${shouldReconnect}`);
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                logger.error('Sessão encerrada (Logout). Necessário apagar a pasta auth no volume.');
            }
        } else if (connection === 'open') {
            logger.info(' Conectado ao WhatsApp com sucesso!');
        }
    });
};

const sendMessage = async (number, text) => {
    if (!sock) throw new Error('WhatsApp ainda não inicializou.');
    
    let id = number.replace(/\D/g, ''); 
    if (!id.includes('@s.whatsapp.net')) {
        id = `${id}@s.whatsapp.net`;
    }
    
    await sock.presenceSubscribe(id);
    await sock.sendMessage(id, { text });
    return { status: 'enviado', to: id };
};

connectToWhatsApp();

module.exports = {
    sendMessage,
    client: () => sock
};
