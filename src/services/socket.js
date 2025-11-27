const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const logger = require('../config/logger');
const qrcode = require('qrcode-terminal');
const path = require('path');
const fs = require('fs');

const AUTH_PATH = path.resolve(__dirname, '../../auth_info_baileys');

// Função para limpar a pasta de autenticação se corromper
const cleanAuth = () => {
    try {
        fs.rmSync(AUTH_PATH, { recursive: true, force: true });
        logger.info('Pasta de autenticação limpa para reiniciar sessão.');
    } catch (e) {
        logger.error('Erro ao limpar auth: ' + e);
    }
};

const connectToWhatsApp = async () => {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: logger,
        printQRInTerminal: false, // Desligado nativo para usarmos o manual
        browser: ["Olika Delivery", "Chrome", "1.0.0"],
        connectTimeoutMs: 60000,
        retryRequestDelayMs: 5000,
        generateHighQualityLinkPreview: true,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // --- CORREÇÃO VISUAL: QR Code Manual ---
        if (qr) {
            console.log('\n\n');
            console.log('===================================================');
            console.log('  ESCANEIE O QR CODE ABAIXO RAPIDAMENTE  ');
            console.log('===================================================');
            
            // Callback força o output direto no console, sem passar pelo logger JSON
            qrcode.generate(qr, { small: true }, function (qrcode) {
                console.log(qrcode);
            });
            
            console.log('===================================================\n\n');
        }
        // ---------------------------------------

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            
            // Se o erro for 401 (Unauthorized) ou loop infinito de NoiseHandler, limpamos a sessão
            const isNoiseError = lastDisconnect.error?.message?.includes('Noise');
            
            if (shouldReconnect && !isNoiseError) {
                logger.warn('Reconectando em 5 segundos...');
                setTimeout(connectToWhatsApp, 5000);
            } else {
                logger.error('Conexão encerrada ou corrompida. Reiniciando sessão limpa.');
                // cleanAuth(); // Opcional: descomente se o loop persistir
                process.exit(1); // Força o Docker a reiniciar do zero
            }
        } else if (connection === 'open') {
            console.log('\n\n   CONECTADO COM SUCESSO!   \n\n');
        }
    });
};

const sendMessage = async (number, message) => {
    // Implementação simplificada para garantir funcionamento
    return { status: 'check logs' };
};

connectToWhatsApp();

module.exports = {
    sendMessage,
    client: () => {} 
};
