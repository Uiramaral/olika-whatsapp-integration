const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const logger = require('../config/logger');
const qrcode = require('qrcode-terminal'); // Biblioteca para desenhar o QR
const path = require('path');
const fs = require('fs');

const AUTH_PATH = path.resolve(__dirname, '../../auth_info_baileys');

let sock;

const connectToWhatsApp = async () => {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_PATH);

    sock = makeWASocket({
        // REMOVIDO: printQRInTerminal: true (Isso não funciona mais)
        auth: state,
        logger: logger,
        browser: ["Olika Delivery", "Chrome", "1.0.0"],
        connectTimeoutMs: 60000,
        // Configuração para evitar erros de "noise"
        syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // --- CORREÇÃO: Desenhar QR Code Manualmente ---
        if (qr) {
            logger.info(' QR Code recebido. Gerando abaixo:');
            // small: true garante que o QR caiba na tela do log
            qrcode.generate(qr, { small: true }); 
        }
        // ----------------------------------------------

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            
            if (shouldReconnect) {
                logger.warn('Conexão instável. Tentando reconectar em 5 segundos...');
                // Adiciona um delay de 5s para não "spammar" o log
                setTimeout(connectToWhatsApp, 5000);
            } else {
                logger.error('Sessão encerrada (Logout). Necessário apagar a pasta auth no volume.');
                // Encerra o processo para o Docker reiniciar limpo se necessário
                process.exit(1);
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
