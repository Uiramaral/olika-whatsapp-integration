// utils/ai_processor.js

const { downloadContentFromMessage, getContentType } = require('@whiskeysockets/baileys');
const { OpenAI } = require('openai');
const pdf = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const logger = require('../config/logger'); 

// Configuração da OpenAI (necessária aqui para as chamadas condicionais Whisper)
const OPENAI_TIMEOUT = parseInt(process.env.OPENAI_TIMEOUT) * 1000 || 30000; 
const openai = new OpenAI({ 
    apiKey: process.env.OPENAI_API_KEY,
    timeout: OPENAI_TIMEOUT
});

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

// 2. Transcreve Áudio (Usa Whisper API - Custo Adicional)
async function transcribeAudio(audioBuffer, mimeType) {
    const tempFileName = `audio_${Date.now()}.${mimeType.split('/')[1] || 'mp3'}`;
    const tempFilePath = path.join(TEMP_DIR, tempFileName);

    try {
        fs.writeFileSync(tempFilePath, audioBuffer); 
        const transcription = await openai.audio.transcriptions.create({
            model: 'whisper-1', 
            file: fs.createReadStream(tempFilePath),
            response_format: 'text', // 🚨 AJUSTE: Garante o formato de retorno
        });
        return transcription.text;
    } catch (e) {
        logger.error(`❌ ERRO WHISPER API: ${e.message}`);
        return '[ERRO DE TRANSCRIÇÃO]'; 
    } finally {
        if (fs.existsSync(tempFilePath)) {
            fs.unlinkSync(tempFilePath); // CRÍTICO: Limpa o volume do Railway
        }
    }
}

// 3. Função Principal para Extrair o Conteúdo para o GPT-5-nano
async function extractDataForAI(incomingMessage) {
    const type = getContentType(incomingMessage.message);
    const messageContent = incomingMessage.message[type];
    const result = { type: 'text', payload: '' }; 

    switch (type) {
        case 'conversation':
            result.payload = messageContent.conversation || '';
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
                result.payload = `[Documento recebido]. Instrução: Avise o usuário que você só processa texto e PDFs.`;
            }
            break;

        case 'audioMessage':
            try {
                const buffer = await mediaToBuffer(incomingMessage.message);
                const mimeType = messageContent.mimetype || 'audio/mpeg';
                const transcriptionText = await transcribeAudio(buffer, mimeType);
                
                if (transcriptionText === '[ERRO DE TRANSCRIÇÃO]') {
                    // 🚨 AJUSTE: Mensagem de erro humanizada
                    result.payload = "Desculpe, não consegui transcrever o áudio. Por favor, envie a mensagem como texto.";
                } else {
                    result.payload = `[ÁUDIO TRANSCREVIDO: ${transcriptionText}]. Instrução: Responda ao áudio de forma concisa.`;
                }
            } catch (error) {
                logger.error(`❌ Erro ao processar áudio: ${error.message}`);
                result.payload = "Desculpe, houve um erro inesperado ao processar seu áudio. Tente novamente.";
            }
            break;

        case 'imageMessage':
        case 'videoMessage':
            let captionText = messageContent.caption || '';
            let advisoryText = `[MÍDIA VISUAL RECEBIDA: ${type.replace('Message', '').toUpperCase()}]. `;
            
            if (captionText) {
                advisoryText += `O usuário escreveu: "${captionText}". Analise apenas este texto, pois o modelo não consegue ver a imagem/vídeo.`;
            } else {
                advisoryText += `O modelo de IA não possui Visão. Solicite ao usuário que descreva o arquivo.`;
            }
            result.payload = advisoryText;
            break;

        default:
            result.payload = `Mensagem do tipo ${type} recebida. Instrução: Avise o usuário que este tipo de mensagem não é processado.`;
            break;
    }
    
    return result; 
}

module.exports = { extractDataForAI };

