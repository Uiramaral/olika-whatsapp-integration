// utils/ai_processor.js

const { downloadContentFromMessage, getContentType } = require('@whiskeysockets/baileys');
const pdf = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const logger = require('../config/logger'); 

const TEMP_DIR = path.resolve(__dirname, '..', '..', 'temp'); 
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// 1. Baixa a mídia do WhatsApp para Buffer (MEMÓRIA)
async function mediaToBuffer(messageContent) {
    try {
        const type = getContentType(messageContent);
        const stream = await downloadContentFromMessage(messageContent[type], type.replace('Message', '')); 
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }
        return buffer;
    } catch (e) {
        logger.error(`❌ Erro ao baixar stream de mídia: ${e.message}`);
        throw new Error("Falha no download da mídia.");
    }
}

// 3. Função Principal para Extrair o Conteúdo para o GPT-5-nano
async function extractDataForAI(incomingMessage) {
    const type = getContentType(incomingMessage.message);
    const messageContent = incomingMessage.message[type];
    const result = { type: 'text', payload: '' }; 

    switch (type) {
        case 'conversation':
            // Para 'conversation', messageContent JÁ é a string da mensagem.
            result.payload = typeof messageContent === 'string'
                ? messageContent
                : (messageContent?.conversation || '');
            break;
        case 'extendedTextMessage':
            result.payload = messageContent.text || '';
            break;

        case 'documentMessage':
            if (messageContent.mimetype && messageContent.mimetype.includes('pdf')) {
                try {
                    const buffer = await mediaToBuffer(incomingMessage.message);
                    const data = await pdf(buffer);
                    const textSnippet = data.text.substring(0, 4000); 
                    result.payload = `[ANÁLISE DE PDF] Conteúdo: ${textSnippet}. Instrução: Resuma o PDF em 3 frases de forma concisa.`;
                } catch (error) {
                    logger.error(`❌ Erro ao processar PDF: ${error.message}`);
                    result.payload = `[Erro ao processar PDF]. Instrução: Avise o usuário que houve um erro ao processar o documento.`;
                }
            } else {
                result.type = 'documento';
                result.payload = `[Documento recebido]. Instrução: Avise o usuário que você só processa texto e PDFs.`;
            }
            break;

        case 'audioMessage':
            // 🎵 Áudio NÃO é transcrito nesta fase (sem OpenAI/Whisper).
            // O socket.js trata este tipo: avisa o cliente e notifica o administrativo.
            result.type = 'audio';
            result.payload = '[MENSAGEM DE ÁUDIO]';
            break;

        case 'imageMessage':
        case 'videoMessage':
            result.type = 'imagem';
            let captionText = messageContent.caption || '';
            let advisoryText = `[MÍDIA VISUAL RECEBIDA: ${type.replace('Message', '').toUpperCase()}]. `;
            
            if (captionText) {
                advisoryText += `O usuário escreveu: "${captionText}". Analise apenas este texto, pois o modelo não consegue ver a imagem/vídeo.`;
            } else {
                advisoryText += `O modelo de IA não possui Visão. Solicite ao usuário que descreva o arquivo.`;
            }
            result.payload = advisoryText;
            break;

        case 'reactionMessage':
            result.type = 'reaction';
            result.payload = '';
            break;

        case 'orderMessage':
            result.type = 'pedido_catalogo';
            result.orderId = messageContent.orderId || '';
            result.orderToken = messageContent.token || '';
            result.payload = formatOrderMessagePayload(messageContent, incomingMessage._orderDetails || null);
            break;

        default:
            logger.info(`ℹ️ [AI Processor] Mensagem do tipo "${type}" ignorada (sem conteúdo de texto).`);
            result.payload = '';
            break;
    }
    
    return result; 
}

function formatOrderMessagePayload(messageContent, details) {
    const orderId = messageContent?.orderId || '';
    const itemCount = messageContent?.itemCount || 0;
    const note = messageContent?.message || '';
    const totalRaw = messageContent?.totalAmount1000 ? (Number(messageContent.totalAmount1000) / 1000) : 0;
    const total = totalRaw.toFixed(2);

    let lines = [`[PEDIDO VIA CATÁLOGO DO WHATSAPP]`];

    if (details && Array.isArray(details.products) && details.products.length > 0) {
        lines.push(`Itens do Catálogo:`);
        details.products.forEach(p => {
            const qtd = p.quantity || 1;
            const preco = (p.price ? (Number(p.price) / 1000) : 0).toFixed(2);
            lines.push(`- ${qtd}x ${p.name || 'Produto'} (R$ ${preco} cada)`);
        });
    } else {
        lines.push(`Quantidade de itens selecionados no catálogo: ${itemCount}`);
    }

    lines.push(`Subtotal do Catálogo: R$ ${total}`);
    if (note) {
        lines.push(`Observação do cliente: "${note}"`);
    }

    lines.push(`\nInstrução: O cliente enviou um carrinho do catálogo nativo do WhatsApp. Acolha com entusiasmo, confirme os itens e pergunte se deseja entrega ou retirada (e se entrega, solicite o endereço/CEP para calcular a taxa).`);

    return lines.join('\n');
}

module.exports = { extractDataForAI, formatOrderMessagePayload };

