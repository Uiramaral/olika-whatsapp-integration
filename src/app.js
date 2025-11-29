require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { startSock, sendMessage, isConnected } = require('./services/socket');
const logger = require('./config/logger');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_SECRET;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || API_TOKEN; // Fallback para API_SECRET se WEBHOOK_TOKEN não estiver definido

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

// Endpoint de health check (público)
app.get('/', (req, res) => {
    res.json({
        status: 'running',
        connected: isConnected(),
        timestamp: new Date().toISOString()
    });
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
    // Timeout de segurança: resposta em no máximo 8 segundos
    let responseTimeout = setTimeout(() => {
        if (!res.headersSent) {
            logger.warn('⚠️ Timeout no endpoint /api/notify - resposta tardia', {
                order_id: req.body?.order?.id,
                event: req.body?.event,
                phone: req.body?.phone || req.body?.customer?.phone
            });
            res.status(504).json({
                success: false,
                error: 'Timeout interno: aplicação não respondeu a tempo',
                retry: true,
                timeout: true
            });
        }
    }, 8000);

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
            message_length: finalMessage.length
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

// 🚀 Iniciar servidor HTTP PRIMEIRO (independente do Baileys)
app.listen(PORT, () => {
    logger.info(`✅ Servidor HTTP rodando na porta ${PORT}`);
    logger.info(`📡 Endpoints disponíveis:`);
    logger.info(`   - GET  / (health check)`);
    logger.info(`   - POST /send-message (envio simples)`);
    logger.info(`   - POST /api/notify (notificações Laravel)`);
    
    // 🔌 Iniciar Baileys em segundo plano (não bloqueia o Express)
    logger.info(`🔄 Iniciando conexão WhatsApp em segundo plano...`);
    startSock().catch(err => {
        logger.error('❌ Erro ao iniciar WhatsApp (continuando sem WhatsApp):', err.message);
        // Não encerra o servidor - o Express continua funcionando
    });
});
