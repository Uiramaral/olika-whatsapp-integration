const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const logger = require('../config/logger');
const path = require('path');
const fs = require('fs');

// Número de Pareamento: Usado para isolar a sessão no disco
const PAIRING_NUMBER = '5571987019420'; 
const AUTH_PATH = path.resolve(__dirname, '..', '..', 'auth_info_baileys', PAIRING_NUMBER); 

const connectToWhatsApp = async () => {
    //  ATENÇÃO: A pasta auth_info_baileys/5571987019420 deve ser o Volume do Railway!
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

    // CORREÇÃO CRÍTICA: Sincronização e Delay após salvar (evita erro 515)
    sock.ev.on('creds.update', async () => { 
        await saveCreds(); 
        // Espera 1.5s para garantir que o disco finalizou a escrita (flush)
        await new Promise(r => setTimeout(r, 1500)); 
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, isNewLogin } = update;

        if (isNewLogin) {
            console.log('\n\n? NOVO LOGIN: Conectado com sucesso e credenciais salvas! ?\n\n');
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                logger.warn('Conexão instável. Tentando reconectar em 5 segundos...');
                setTimeout(connectToWhatsApp, 5000);
            } else {
                logger.error('Logout detectado. O processo irá encerrar. Limpe o Volume e reinicie o serviço para gerar um novo código.');
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
