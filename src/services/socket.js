const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const logger = require('../config/logger');
const path = require('path');

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
        browser: ["Ubuntu", "Chrome", "20.0.04"], 
        connectTimeoutMs: 60000,
        retryRequestDelayMs: 2000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, isNewLogin } = update;

        if (isNewLogin) {
            console.log('\n\n? NOVO LOGIN: Conectado com sucesso e credenciais salvas! \n\n');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                // Se a falha não for um LOGOUT explícito, tentamos reconectar
                logger.warn('Conexão instável. Tentando reconectar em 5 segundos...');
                setTimeout(connectToWhatsApp, 5000);
            } else {
                // Se o WhatsApp disser que houve LOGOUT, paramos de tentar.
                logger.error('Logout detectado. O processo irá encerrar. Limpe o Volume e reinicie o serviço para gerar um novo código.');
                // Removido process.exit(1) - vamos depender do timeout para encerrar.
            }
        } else if (connection === 'open') {
             console.log('\n\n   CONECTADO COM SUCESSO!   \n\n');
        }
    });

    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                let phoneNumber = PAIRING_NUMBER.replace(/[^0-9]/g, '');
                console.log('\n\nREQUESTING PAIRING CODE FOR: ' + phoneNumber);
                const code = await sock.requestPairingCode(phoneNumber);
                
                console.log('===================================================');
                console.log(' SEU CÓDIGO DE PAREAMENTO: ' + code);
                console.log('===================================================\n\n');
            } catch (err) {
                console.log('Erro ao pedir código: ', err);
            }
        }, 6000);
    }
};

const sendMessage = async (number, message) => {
    return { status: 'running' };
};

connectToWhatsApp();

module.exports = { sendMessage, client: () => {} };
