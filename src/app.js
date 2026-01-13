require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { startSock, sendMessage, isConnected, forceLogout, getCurrentPhone } = require('./services/socket');
const logger = require('./config/logger');

const app = express();
app.use(cors());
app.use(express.json());

// Railway usa porta 8080 por padrão - usar ?? em vez de || para não tratar 0 como falsy
const PORT = process.env.PORT ?? 8080;
const API_TOKEN = process.env.API_SECRET;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || API_TOKEN; // Fallback para API_SECRET se WEBHOOK_TOKEN não estiver definido

// ✅ NOVO: Variáveis de ambiente para multi-instância
const CLIENT_ID = process.env.CLIENT_ID;
const API_TOKEN_NODE = process.env.API_TOKEN || process.env.WH_API_TOKEN || API_TOKEN;
const LARAVEL_API_URL = process.env.LARAVEL_API_URL || process.env.WEBHOOK_URL?.replace('/api/whatsapp/webhook', '') || 'https://devpedido.menuolika.com.br';

// ✅ NOVO: Cliente global
global.client = null;

// Variáveis globais (já inicializadas no socket.js, mas garantindo aqui também)
global.currentQR = null;
global.currentQRTimestamp = null;
global.currentPairingCode = null;
global.currentWhatsAppPhone = null;
global.isConnecting = false; // Flag para evitar múltiplas conexões simultâneas

/**
 * ✅ NOVO: Carrega informações do cliente do Laravel
 */
async function carregarCliente() {
    if (!CLIENT_ID || !API_TOKEN_NODE || !LARAVEL_API_URL) {
        logger.error('❌ Variáveis CLIENT_ID, API_TOKEN ou LARAVEL_API_URL não configuradas');
        throw new Error('Configuração incompleta para multi-instância');
    }

    try {
        const response = await axios.get(
            `${LARAVEL_API_URL}/api/client/${CLIENT_ID}`,
            {
                headers: {
                    'X-API-Token': API_TOKEN_NODE,
                    'Content-Type': 'application/json'
                },
                timeout: 5000
            }
        );

        global.client = response.data;
        logger.info(`✅ Cliente carregado: ${global.client.name} (Plano: ${global.client.plan})`);

        return global.client;
    } catch (error) {
        logger.error(`❌ Erro ao carregar cliente: ${error.message}`);
        throw error;
    }
}

/**
 * ✅ NOVO: Verifica se deve carregar módulos de IA
 */
function deveCarregarIA() {
    return global.client && global.client.has_ia && global.client.plan === 'ia';
}

// Middleware de Segurança para endpoints protegidos
const requireAuth = (req, res, next) => {
    const token = req.headers['x-api-token'] || req.headers['x-webhook-token'] || req.headers['x-olika-token'];
    
    // Se não tiver token configurado, bloquear por segurança
    if (!API_TOKEN && !WEBHOOK_TOKEN) {
        logger.error('ERRO CRÍTICO: Nenhum token configurado no .env');
        return res.status(500).json({ error: 'Configuração de servidor inválida' });
    }

    const validToken = token === API_TOKEN || token === WEBHOOK_TOKEN;
    
    if (validToken) {
        next();
    } else {
        logger.warn(`Tentativa de acesso negado. Token recebido: ${token ? '***' : 'nenhum'}`);
        res.status(403).json({ error: 'Acesso negado' });
    }
};

// Endpoint de health check (público) - SEMPRE responde, mesmo se Baileys não estiver pronto
app.get('/', (req, res) => {
    try {
        res.json({
            status: 'running',
            connected: isConnected(),
            uptime: Math.floor(process.uptime()),
            timestamp: new Date().toISOString(),
            port: PORT
        });
    } catch (error) {
        // Fallback caso algo dê errado
        res.status(200).json({
            status: 'running',
            connected: false,
            error: 'Erro ao verificar status',
            timestamp: new Date().toISOString()
        });
    }
});

// Endpoint para obter QR Code atual (protegido por autenticação)
// Endpoint removido - não vamos mais usar QR Code, apenas código de pareamento via status

// --- Rota de Status (GET /status) ---
// Permite que o Dashboard (Laravel) leia o status
app.get('/api/whatsapp/status', requireAuth, (req, res) => {
    res.json({
        connected: isConnected(), // Mantido para compatibilidade com Laravel
        isConnected: isConnected(), // Novo padrão
        isConnecting: global.isConnecting || false, // 🆕 Flag de conexão em andamento
        pairingCode: global.currentPairingCode || null, 
        currentPhone: getCurrentPhone() || null, 
        message: isConnected() 
            ? 'Conectado e Operacional' 
            : (global.isConnecting 
                ? 'Conectando...' 
                : (global.currentPairingCode 
                    ? 'Aguardando Pareamento' 
                    : 'Em Standby (Offline)'))
    });
});

// Função para buscar número do WhatsApp do banco de dados
// IMPORTANTE: Prioriza sempre o banco de dados sobre variáveis de ambiente
async function getWhatsAppPhone() {
    const laravelApiUrl = process.env.LARAVEL_API_URL || 'https://devpedido.menuolika.com.br';
    const laravelApiKey = process.env.API_SECRET || API_TOKEN;
    
    try {
        // Usar require('https') ou 'http' para fazer requisição (Node.js nativo)
        const https = require('https');
        const http = require('http');
        const url = require('url');
        
        const apiUrl = new URL(`${laravelApiUrl}/api/whatsapp/settings`);
        const client = apiUrl.protocol === 'https:' ? https : http;
        
        return new Promise((resolve, reject) => {
            logger.info(`🔍 Fazendo requisição para: ${apiUrl.href}`);
            logger.info(`🔑 Token usado: ${laravelApiKey ? '***' + laravelApiKey.slice(-4) : 'não fornecido'}`);
            logger.info(`🌍 process.env.WHATSAPP_PHONE atual: ${process.env.WHATSAPP_PHONE || 'não definido'}`);
            
            const req = client.request({
                hostname: apiUrl.hostname,
                port: apiUrl.port || (apiUrl.protocol === 'https:' ? 443 : 80),
                path: apiUrl.pathname,
                method: 'GET',
                headers: {
                    'X-API-Token': laravelApiKey,
                    'Accept': 'application/json'
                }
            }, (res) => {
                logger.info(`📡 Status HTTP da resposta: ${res.statusCode}`);
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    // ❌ PRIMEIRO: Verificar status HTTP ANTES de parsear JSON
                    if (res.statusCode === 403) {
                        logger.error(`❌ Erro de autenticação (403). Token inválido ou não fornecido.`);
                        logger.error(`📋 Resposta: ${data}`);
                        logger.error(`🔑 Token enviado: ${laravelApiKey ? '***' + laravelApiKey.slice(-4) : 'não fornecido'}`);
                        logger.error(`⚠️ Verifique se API_SECRET no Railway é igual ao API_SECRET/WEBHOOK_TOKEN no Laravel`);
                        const fallback = process.env.WHATSAPP_PHONE || "5571987019420";
                        logger.warn(`⚠️ Usando número fallback devido a erro de autenticação: ${fallback}`);
                        resolve(fallback);
                        return;
                    }
                    
                    // ❌ Se houver outro erro HTTP, não aceitar o número
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        logger.error(`❌ Erro HTTP ${res.statusCode} ao buscar número do WhatsApp`);
                        logger.error(`📋 Resposta: ${data}`);
                        const fallback = process.env.WHATSAPP_PHONE || "5571987019420";
                        logger.warn(`⚠️ Usando número fallback devido a erro HTTP: ${fallback}`);
                        resolve(fallback);
                        return;
                    }
                    
                    // ✅ Só parsear JSON se o status for OK
                    try {
                        logger.info(`📥 Dados brutos recebidos: ${data}`);
                        const settings = JSON.parse(data);
                        logger.info(`📥 Resposta do Laravel parseada: ${JSON.stringify(settings)}`);
                        
                        // ❌ Se houver erro na resposta JSON, não aceitar o número
                        if (settings.error) {
                            logger.error(`❌ Erro na resposta do Laravel: ${settings.error}`);
                            const fallback = process.env.WHATSAPP_PHONE || "5571987019420";
                            logger.warn(`⚠️ Usando número fallback devido a erro na resposta: ${fallback}`);
                            resolve(fallback);
                            return;
                        }
                        
                        // ✅ PRIORIDADE: Banco de dados primeiro, depois .env, depois padrão
                        if (settings.whatsapp_phone && String(settings.whatsapp_phone).trim() !== '') {
                            const phoneNumber = String(settings.whatsapp_phone).trim();
                            logger.info(`✅ Número obtido do banco de dados: ${phoneNumber}`);
                            logger.info(`⚠️ IGNORANDO process.env.WHATSAPP_PHONE (${process.env.WHATSAPP_PHONE || 'não definido'}) - usando banco de dados`);
                            resolve(phoneNumber);
                        } else {
                            logger.warn('⚠️ Número não encontrado no banco de dados ou está vazio');
                            logger.warn(`📋 Resposta completa: ${JSON.stringify(settings)}`);
                            logger.warn(`📋 Tipo de whatsapp_phone: ${typeof settings.whatsapp_phone}`);
                            logger.warn(`📋 Valor: ${settings.whatsapp_phone}`);
                            // Se não tiver no banco, usar .env ou padrão
                            const fallback = process.env.WHATSAPP_PHONE || "5571987019420";
                            logger.info(`📱 Usando número fallback: ${fallback} (fonte: ${process.env.WHATSAPP_PHONE ? '.env' : 'padrão'})`);
                            resolve(fallback);
                        }
                    } catch (e) {
                        logger.warn('Erro ao parsear resposta do Laravel:', e.message);
                        logger.warn(`📋 Dados recebidos: ${data}`);
                        const fallback = process.env.WHATSAPP_PHONE || "5571987019420";
                        logger.info(`📱 Usando número fallback (erro parse): ${fallback}`);
                        resolve(fallback);
                    }
                });
            });
            
            req.on('error', (error) => {
                logger.warn(`⚠️ Erro ao buscar número do WhatsApp do Laravel: ${error.message}`);
                const fallback = process.env.WHATSAPP_PHONE || "5571987019420";
                logger.info(`📱 Usando número fallback (erro conexão): ${fallback}`);
                resolve(fallback);
            });
            
            req.setTimeout(5000, () => {
                req.destroy();
                logger.warn('⏱️ Timeout ao buscar número do WhatsApp do Laravel (5s)');
                const fallback = process.env.WHATSAPP_PHONE || "5571987019420";
                logger.info(`📱 Usando número fallback (timeout): ${fallback}`);
                resolve(fallback);
            });
            
            req.end();
        });
    } catch (error) {
        logger.warn('Erro ao buscar número do WhatsApp, usando fallback:', error.message);
        const fallback = process.env.WHATSAPP_PHONE || "5571987019420";
        logger.info(`📱 Usando número fallback (erro geral): ${fallback}`);
        return fallback;
    }
}

// Endpoint para desconectar WhatsApp manualmente
// Endpoint de desconexão removido - use restartWhatsAppConnection() para reiniciar
// app.post('/api/whatsapp/disconnect', ...) - não mais necessário

// Endpoint para limpar credenciais corrompidas (útil para resolver problemas de sessão)
app.post('/api/whatsapp/clear-auth', requireAuth, async (req, res) => {
    try {
        logger.info('🗑️ Solicitação de limpeza de credenciais recebida');
        
        const { startSock } = require('./services/socket');
        const fs = require('fs').promises;
        const path = require('path');
        
        // Buscar número do WhatsApp
        const whatsappPhone = await getWhatsAppPhone();
        const SESSION_BASE_DIR = path.resolve(process.cwd(), "auth_info_baileys");
        const SESSION_PATH = path.resolve(SESSION_BASE_DIR, whatsappPhone);
        
        // Limpar todos os arquivos da sessão
        try {
            const files = await fs.readdir(SESSION_PATH).catch(() => []);
            let deletedCount = 0;
            
            for (const file of files) {
                const filePath = path.join(SESSION_PATH, file);
                await fs.unlink(filePath).catch(() => {});
                deletedCount++;
            }
            
            // Limpar estado global
            global.sock = null;
            global.isWhatsAppConnected = false;
            global.whatsappUser = null;
            global.currentQR = null;
            global.currentQRTimestamp = null;
            global.currentPairingCode = null;
            
            logger.info(`✅ ${deletedCount} arquivo(s) de sessão removido(s)`);
            
            res.json({
                success: true,
                message: `Credenciais limpas com sucesso. ${deletedCount} arquivo(s) removido(s).`,
                deleted_files: deletedCount
            });
        } catch (error) {
            logger.error('Erro ao limpar credenciais:', error);
            res.status(500).json({
                success: false,
                error: 'Erro ao limpar credenciais: ' + error.message
            });
        }
    } catch (error) {
        logger.error('Erro no endpoint de limpeza:', error);
        res.status(500).json({
            success: false,
            error: 'Erro interno: ' + error.message
        });
    }
});

// --- Rota de Conexão (POST /connect) ---
// Essencial para tirar o sistema do STANDBY e gerar um novo código
app.post('/api/whatsapp/connect', requireAuth, async (req, res) => {
    try {
        const { phone } = req.body;
        if (!phone) {
            return res.status(400).json({ error: 'O número de telefone (phone) é obrigatório no corpo da requisição.' });
        }
        
        // 🆕 Verificar se já está conectado
        if (isConnected()) {
            return res.status(400).json({ 
                error: 'WhatsApp já está conectado.', 
                connected: true,
                currentPhone: getCurrentPhone()
            });
        }
        
        // 🆕 Verificar se já está tentando conectar (evita duplicação)
        if (global.isConnecting) {
            return res.status(429).json({ 
                error: 'Conexão já em andamento. Aguarde o código de pareamento.',
                isConnecting: true,
                pairingCode: global.currentPairingCode || null
            });
        }
        
        // 🆕 Marcar como conectando
        global.isConnecting = true;
        
        // Inicia ou configura o número e tenta gerar o código
        await startSock(phone);
        
        // 🆕 Aguardar até 8 segundos pelo código de pareamento (3s delay + 5s margem)
        let attempts = 0;
        const maxAttempts = 16; // 16 * 500ms = 8 segundos
        
        while (!global.currentPairingCode && attempts < maxAttempts) {
            await new Promise(resolve => setTimeout(resolve, 500));
            attempts++;
        }
        
        // Liberar flag após timeout
        setTimeout(() => {
            if (!isConnected()) {
                global.isConnecting = false;
            }
        }, 60000); // Libera após 1 minuto se não conectar

        res.json({ 
            success: true, 
            message: `Conexão iniciada para o número: ${phone}.`,
            pairingCode: global.currentPairingCode || null,
            waitingForCode: !global.currentPairingCode
        });
    } catch (error) {
        global.isConnecting = false; // 🆕 Liberar flag em caso de erro
        logger.error('Erro na rota /connect:', error.message);
        res.status(500).json({ error: 'Falha ao iniciar a conexão.' });
    }
});


// Enviar mensagem manualmente
app.post('/api/whatsapp/send', requireAuth, async (req, res) => {
    try {
        const { number, message } = req.body;
        if (!number || !message) {
            return res.status(400).json({ error: 'Número e mensagem são obrigatórios.' });
        }

        const result = await sendMessage(number, message);
        res.json({ success: true, number, message, messageId: result.messageId });
    } catch (err) {
        logger.error('Erro ao enviar mensagem:', err);
        res.status(500).json({ error: err.message });
    }
});

// Endpoint simples para envio direto (mantido para compatibilidade)
app.post('/send-message', requireAuth, async (req, res) => {
    try {
        const { number, message } = req.body;
        
        if (!number || !message) {
            return res.status(400).json({ error: 'Campos obrigatórios: number, message' });
        }

        if (!isConnected()) {
            return res.status(503).json({ error: 'WhatsApp não está conectado. Aguarde a conexão ser estabelecida.' });
        }

        const result = await sendMessage(number, message);
        logger.info(`✅ Mensagem enviada para ${number}`);
        res.json(result);

    } catch (error) {
        logger.error(`❌ Erro no envio: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

// --- Rota de Reset Manual (POST /restart) ---
// O "Botão de Pânico" que executa o forceLogout para limpeza e Standby
app.post('/api/whatsapp/restart', requireAuth, async (req, res) => {
    try {
        const result = await forceLogout(); // Esta é a nova função
        res.json(result);
    } catch (error) {
        logger.error('Erro na rota /restart:', error.message);
        res.status(500).json({ error: 'Falha ao forçar o logout da sessão.' });
    }
});

/**
 * Endpoint profissional para notificações do Laravel
 * Processa payload completo e gera mensagem formatada
 * 
 * IMPORTANTE: Responde rapidamente mesmo durante reconexão do Baileys
 * para evitar timeout do proxy Railway (502)
 * 
 * Aceita dois formatos:
 * 1. Simples: { phone, message }
 * 2. Completo: { event, order, customer, phone?, message? }
 */
app.post('/api/notify', requireAuth, async (req, res) => {
    // Timeout de segurança: resposta em no máximo 6 segundos (AJUSTADO PARA RAILWAY)
    let responseTimeout = setTimeout(() => {
        if (!res.headersSent) {
            logger.warn('⚠️ Timeout no endpoint /api/notify - resposta tardia', {
                order_id: req.body?.order?.id,
                event: req.body?.event,
                phone: req.body?.phone || req.body?.customer?.phone,
                'X-Request-ID': req.headers['x-request-id'] || 'N/A' // 🚨 Rastreamento
            });
            res.status(504).json({
                success: false,
                error: 'Timeout interno: aplicação não respondeu a tempo',
                retry: true,
                timeout: true
            });
        }
    }, 6000); // 🚨 AJUSTADO PARA 6s

    // Função auxiliar para limpar timeout e garantir resposta única
    const clearTimeoutAndRespond = (statusCode, jsonResponse) => {
        clearTimeout(responseTimeout);
        if (!res.headersSent) {
            res.status(statusCode).json(jsonResponse);
        }
    };

    try {
        const { event, order, customer, phone, message } = req.body;
        
        // Verificar conexão ANTES de qualquer processamento (resposta imediata)
        if (!isConnected()) {
            logger.warn('⚠️ Tentativa de envio enquanto WhatsApp desconectado/reconectando', { 
                phone: phone || customer?.phone,
                order_id: order?.id 
            });
            return clearTimeoutAndRespond(503, { 
                success: false,
                error: 'WhatsApp não conectado. Tente novamente em alguns segundos.',
                retry: true,
                connected: false
            });
        }

        // Determinar telefone (prioridade: phone direto > customer.phone)
        const targetPhone = phone || customer?.phone;
        
        // Validar telefone
        if (!targetPhone) {
            return clearTimeoutAndRespond(400, { 
                success: false,
                error: 'Telefone do cliente é obrigatório (phone ou customer.phone)' 
            });
        }

        // Determinar mensagem final
        let finalMessage = message;
        
        // Se não tiver mensagem mas tiver dados do pedido, formatar
        if (!finalMessage && order) {
            finalMessage = formatOrderMessage(event, order, customer);
        }
        
        // Se ainda não tiver mensagem, criar fallback
        if (!finalMessage) {
            if (event) {
                const eventLabels = {
                    'order_created': '🍕 Pedido recebido',
                    'order_preparing': '👩‍🍳 Pedido em preparo',
                    'order_ready': '🚗 Pedido pronto para entrega',
                    'order_completed': '✅ Pedido entregue',
                };
                
                const eventLabel = eventLabels[event] || '📦 Atualização do pedido';
                finalMessage = `${eventLabel}\n\nPedido #${order?.number || order?.id || 'N/A'}`;
            } else {
                return clearTimeoutAndRespond(400, { 
                    success: false,
                    error: 'Mensagem é obrigatória quando não há dados de pedido' 
                });
            }
        }

        // Enviar mensagem com timeout interno (6 segundos)
        const sendPromise = sendMessage(targetPhone, finalMessage);
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Timeout ao enviar mensagem (6s)')), 6000);
        });

        const result = await Promise.race([sendPromise, timeoutPromise]);
        
        clearTimeout(responseTimeout);
        
        logger.info('📩 Notificação enviada com sucesso', {
            event,
            order_id: order?.id,
            order_number: order?.number,
            phone: targetPhone,
            message_length: finalMessage.length,
            'X-Request-ID': req.headers['x-request-id'] || 'N/A' // 🚨 Rastreamento
        });

        if (!res.headersSent) {
            return res.json({
                success: true,
                messageId: result.messageId,
                sent_at: new Date().toISOString()
            });
        }

    } catch (error) {
        // Se já respondeu, não responder novamente
        if (res.headersSent) {
            logger.error('❌ Erro após resposta já enviada', { error: error.message });
            return;
        }
        
        logger.error('❌ Erro ao processar notificação', {
            error: error.message,
            order_id: req.body?.order?.id,
            event: req.body?.event,
            phone: req.body?.phone || req.body?.customer?.phone
        });
        
        // Se for timeout, retornar 503 com retry
        if (error.message.includes('Timeout') || error.message.includes('timeout')) {
            return clearTimeoutAndRespond(503, { 
                success: false,
                error: 'Timeout ao enviar mensagem. WhatsApp pode estar reconectando.',
                retry: true,
                timeout: true
            });
        }
        
        return clearTimeoutAndRespond(500, { 
            success: false,
            error: error.message || 'Falha no envio WhatsApp'
        });
    }
});

/**
 * Formata mensagem baseada no evento e dados do pedido
 */
function formatOrderMessage(event, order, customer) {
    const customerName = customer?.name || 'Cliente';
    const orderNumber = order?.number || order?.id || 'N/A';
    const total = order?.total ? `R$ ${parseFloat(order.total).toFixed(2).replace('.', ',')}` : 'R$ 0,00';
    
    const messages = {
        'order_created': `✅ *Pedido Confirmado!*\n\n` +
            `Olá, ${customerName}! Recebemos o pedido *#${orderNumber}* e já estamos separando tudo com carinho.\n\n` +
            `💰 Total: ${total}\n\n` +
            `Assim que a entrega estiver a caminho, avisaremos por aqui!`,
            
        'order_preparing': `👩‍🍳 *Pedido em Preparo*\n\n` +
            `Olá, ${customerName}! O pedido *#${orderNumber}* está sendo preparado com muito carinho.\n\n` +
            `Em breve estará pronto! 🍕`,
            
        'order_ready': `🚗 *Pedido Pronto para Entrega!*\n\n` +
            `Olá, ${customerName}! O pedido *#${orderNumber}* já está pronto e aguardando a coleta do entregador.\n\n` +
            `Obrigado por comprar com a Olika!`,
            
        'order_completed': `🎉 *Pedido Entregue!*\n\n` +
            `Olá, ${customerName}! Confirmamos que o pedido *#${orderNumber}* foi entregue com sucesso.\n\n` +
            `Agradecemos a preferência e esperamos que aproveite! 😋`,
    };
    
    return messages[event] || `📦 Atualização do pedido *#${orderNumber}*\n\nStatus: ${event}`;
}

// Declarar server no escopo global para uso no graceful shutdown
let server = null;

// --- Bloco de Graceful Shutdown ---
const gracefulShutdown = async (signal) => {
    logger.info(`\n\n🛑 Sinal ${signal} recebido. Iniciando Graceful Shutdown...`);
    
    // 1. Tenta desconectar o WhatsApp de forma limpa
    if (global.sock) {
        logger.info('🔗 Encerrando conexão Baileys (logout)...');
        try {
            await global.sock.logout(); // Tenta o logout limpo
            logger.info('✅ Baileys desconectado e credenciais salvas.');
        } catch (error) {
            // Se falhar, tenta encerrar o socket de qualquer forma
            logger.error('⚠️ Falha no logout Baileys, tentando encerrar o socket:', error.message);
            try {
                await global.sock.end();
            } catch (e) {
                logger.error('⚠️ Erro ao encerrar socket:', e.message);
            }
        }
    }
    
    // 2. Fecha o servidor HTTP para novas conexões
    if (server) {
        server.close(() => {
            logger.info('✅ Servidor HTTP encerrado.');
            process.exit(0); // Encerra o processo limpo
        });
        
        // 3. Timeout para forçar o encerramento se o Baileys travar
        setTimeout(() => {
            logger.error('❌ Shutdown timeout. Forçando encerramento.');
            process.exit(1);
        }, 10000); // 10 segundos para o Railway
    } else {
        // Se o servidor não estiver rodando, encerra imediatamente
        process.exit(0);
    }
};

// Capturar os sinais de encerramento do sistema (Railway envia SIGTERM)
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// 🚀 CRÍTICO: Iniciar servidor HTTP IMEDIATAMENTE (independente do Baileys)
// IMPORTANTE: Escutar em 0.0.0.0 para permitir acesso externo do Railway
// Sem isso, o Railway não consegue acessar o container (erro "Application failed to respond")
// ✅ NOVO: Carregar cliente antes de iniciar servidor
(async () => {
    try {
        await carregarCliente();
        
        // Só inicia serviços se cliente estiver ativo
        if (!global.client.active) {
            logger.error('❌ Cliente inativo. Serviços não iniciados.');
            process.exit(1);
        }

        // Se plano for básico, não carrega IA
        if (!deveCarregarIA()) {
            logger.warn('⚠️ Plano básico detectado. Módulos de IA não serão carregados.');
        }

        // Iniciar servidor após carregar cliente
        iniciarServidor();
    } catch (error) {
        logger.error('❌ Falha ao inicializar. Encerrando...');
        process.exit(1);
    }
})();

function iniciarServidor() {
    // O app.listen retorna o objeto Server - precisamos capturá-lo para graceful shutdown
    server = app.listen(PORT, '0.0.0.0', () => {
        logger.info(`✅ Servidor HTTP rodando na porta ${PORT}`);
        logger.info('📡 Endpoints disponíveis:');
        logger.info('   - GET  / (health check)');
        logger.info('   - GET  /api/whatsapp/status');
        logger.info('   - POST /api/whatsapp/connect');
        logger.info('   - POST /api/whatsapp/send');
        logger.info('   - POST /api/notify (notificações Laravel)');
        logger.info('⏸️ Servidor pronto. Aguardando solicitação de conexão via /api/whatsapp/connect');
    });
}
