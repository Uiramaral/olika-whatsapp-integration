const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const logger = require('../config/logger');
const path = require('path');
const fs = require('fs');

const AUTH_PATH = path.resolve(__dirname, '../../auth_info_baileys');

// Número para pareamento (injetado via script)
const PAIRING_NUMBER = '557187019420'; 

const connectToWhatsApp = async () => {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger: logger,
        printQRInTerminal: false, // QR Code desligado
        mobile: false, 
        browser: ["Olika Delivery", "Chrome", "1.0.0"],
        connectTimeoutMs: 60000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                logger.warn('Reconectando...');
                setTimeout(connectToWhatsApp, 3000);
            } else {
                logger.error('Sessão encerrada. Reinicie o volume se necessário.');
                process.exit(1);
            }
        } else if (connection === 'open') {
            console.log('\n\n   CONECTADO COM SUCESSO!   \n\n');
        }
    });

    // Lógica do Código de Pareamento
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                // Formata numero para garantir compatibilidade
                let phoneNumber = PAIRING_NUMBER.replace(/[^0-9]/g, '');
                
                console.log('\n\nREQUESTING PAIRING CODE FOR: ' + phoneNumber);
                const code = await sock.requestPairingCode(phoneNumber);
                
                console.log('===================================================');
                console.log(' SEU CÓDIGO DE PAREAMENTO: ' + code);
                console.log('===================================================\n\n');
            } catch (err) {
                console.log('Erro ao pedir código: ', err);
            }
        }, 5000); // Aguarda 5s para garantir conexão inicial
    }
};

const sendMessage = async (number, message) => {
    return { status: 'service running' };
};

connectToWhatsApp();

module.exports = { sendMessage, client: () => {} };
