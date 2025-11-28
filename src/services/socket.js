const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const logger = require('../config/logger');
const path = require('path');
const fs = require('fs');

const PAIRING_NUMBER = '5571987019420'; 
const AUTH_PATH = path.resolve(__dirname, '..', '..', 'auth_info_baileys', PAIRING_NUMBER); 

let heartbeatInterval = null;
let lastConnected = null; // Para logging do Uptime

const connectToWhatsApp = async () => {
    // Configuraes explcitas e otimizadas para ambientes headless
    const socketConfig = {
        logger: logger,
        printQRInTerminal: false,
        mobile: false, 
        browser: ["Ubuntu", "Chrome", "20.0.04"], 
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000, 
        retryRequestDelayMs: 2000, 
        syncFullHistory: false, 
        markOnlineOnConnect: true,
        getMessage: async (key) => { return { conversation: 'Fallback Message' }; }
    };

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const { version } = await fetchLatestBaileysVersion();
    
    socketConfig.version = version;
    socketConfig.auth = {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
    };

    const sock = makeWASocket(socketConfig);

    // OTIMIZAO: Delay de 2s para garantir o flush completo no disco (evitando erro 515)
    sock.ev.on('creds.update', async () => { 
        await saveCreds(); 
        await new Promise(r => setTimeout(r, 2000)); 
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, isNewLogin } = update;

        // OTIMIZAO: Heartbeat Ping e Logging do Uptime
        if (connection === 'open') {
            lastConnected = Date.now();
            console.log('\n\n   CONECTADO COM SUCESSO!   \n\n');
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            
            // Heartbeat: Envia um ping a cada 20 segundos para evitar timeout (Keep-Alive)
            heartbeatInterval = setInterval(() => {
                if (sock.ws.readyState === 1) { // 1 = OPEN
                    sock.ws.send(' '); 
                }
            }, 20000); 
        }

        if (connection === 'close') {
            if (heartbeatInterval) clearInterval(heartbeatInterval);

            // CORREO E LOGGING DO UPTIME
            if (lastConnected) {
                const uptime = ((Date.now() - lastConnected) / 1000 / 60).toFixed(1);
                // FIX DE SINTAXE: Template string correto para evitar o SyntaxError
                console.log( Desconectado aps  minutos online.);
            }

            const statusCode = lastDisconnect.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                // OTIMIZAO: Aumenta o delay de reconexo para 10 segundos
                logger.warn('Conexão instável. Tentando reconectar em 10 segundos...');
                setTimeout(connectToWhatsApp, 10000); // 10s fixos
            } else {
                logger.error('Logout detectado. O processo ir encerrar. Limpe o Volume e reinicie o servio para gerar um novo cdigo.');
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
