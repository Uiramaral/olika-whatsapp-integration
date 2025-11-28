const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const logger = require('../config/logger');
const path = require('path');
const fs = require('fs');

const PAIRING_NUMBER = '5571987019420'; 
const AUTH_PATH = path.resolve(__dirname, '..', '..', 'auth_info_baileys', PAIRING_NUMBER); 

let heartbeatInterval = null;

const connectToWhatsApp = async () => {
    // Para ambientes headless, historySync: false reduz a carga e melhora o tempo de conexão.
    const socketConfig = {
        logger: logger,
        printQRInTerminal: false,
        mobile: false, 
        browser: ["Ubuntu", "Chrome", "20.0.04"], 
        connectTimeoutMs: 60000,
        retryRequestDelayMs: 2000, 
        syncFullHistory: false, // Confirma que a sincronização completa está desabilitada
        getMessage: async (key) => { return { conversation: 'Fallback Message' }; } // Fallback de mensagem
    };

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const { version } = await fetchLatestBaileysVersion();
    
    socketConfig.version = version;
    socketConfig.auth = {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
    };

    const sock = makeWASocket(socketConfig);

    // OTIMIZAÇÃO: Delay de 2s para garantir o flush completo no disco (evitando erro 515)
    sock.ev.on('creds.update', async () => { 
        await saveCreds(); 
        await new Promise(r => setTimeout(r, 2000)); 
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, isNewLogin } = update;

        // OTIMIZAÇÃO: Heartbeat Ping para manter o WebSocket ativo
        if (connection === 'open') {
            console.log('\n\n   CONECTADO COM SUCESSO!   \n\n');
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            // Envia um ping a cada 20 segundos para evitar que o servidor do WhatsApp desconecte por inatividade
            heartbeatInterval = setInterval(() => {
                if (sock.ws.readyState === sock.ws.OPEN) {
                    sock.ws.send(' '); 
                }
            }, 20000); 
        }

        if (connection === 'close') {
            // Se cair, limpa o heartbeat
            if (heartbeatInterval) clearInterval(heartbeatInterval);

            const statusCode = lastDisconnect.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                logger.warn('Conexão instável. Tentando reconectar em 5 segundos...');
                setTimeout(connectToWhatsApp, 5000);
            } else {
                logger.error('Logout detectado. O processo irá encerrar. Limpe o Volume e reinicie o servio para gerar um novo cdigo.');
            }
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
