const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const logger = require('../config/logger');
const path = require('path');
const fs = require('fs');

const AUTH_PATH = path.resolve(__dirname, '../../auth_info_baileys');
const PAIRING_NUMBER = '5571987019420'; 

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
        printQRInTerminal: false,
        mobile: false, 
        // TRUQUE: Mudamos para Ubuntu/Chrome para parecer um servidor Linux padrão
        browser: ["Ubuntu", "Chrome", "20.0.04"], 
        connectTimeoutMs: 60000,
        retryRequestDelayMs: 2000, // Tenta reconectar mais rápido se falhar
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                logger.warn('Conexão caiu. Reconectando...');
                setTimeout(connectToWhatsApp, 3000);
            } else {
                logger.error('Logout detectado. Necessário limpar volume.');
                process.exit(1); 
            }
        } else if (connection === 'open') {
            console.log('\n\n? ? ? CONECTADO COM SUCESSO! ? ? ?\n\n');
        }
    });

    // Pede o código apenas se não estiver registrado
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let phoneNumber = PAIRING_NUMBER.replace(/[^0-9]/g, '');
                console.log('\n\nREQUESTING PAIRING CODE FOR: ' + phoneNumber);
                
                const code = await sock.requestPairingCode(phoneNumber);
                
                console.log('===================================================');
                console.log('? SEU CÓDIGO DE PAREAMENTO: ' + code);
                console.log('===================================================\n\n');
            } catch (err) {
                console.log('Erro ao pedir código (verifique se o número está correto): ', err);
            }
        }, 6000); // Espera 6s para garantir estabilidade
    }
};

const sendMessage = async (number, message) => {
    return { status: 'running' };
};

connectToWhatsApp();

module.exports = { sendMessage, client: () => {} };
