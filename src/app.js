require('dotenv').config();
const express = require('express');
const { sendMessage, isConnected } = require('./services/socket');
const logger = require('./config/logger');

const app = express();
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
 */
app.post('/api/notify', requireAuth, async (req, res) => {
    try {
        const { event, order, customer, phone, message } = req.body;
        
        // Validar campos obrigatórios
        if (!phone && !customer?.phone) {
            return res.status(400).json({ error: 'Telefone do cliente é obrigatório (phone ou customer.phone)' });
        }

        if (!isConnected()) {
            logger.warn('Tentativa de envio enquanto WhatsApp desconectado', { phone: phone || customer?.phone });
            return res.status(503).json({ 
                error: 'WhatsApp não está conectado. A mensagem será perdida.',
                retry: true 
            });
        }

        // Determinar telefone (prioridade: phone direto > customer.phone)
        const targetPhone = phone || customer?.phone;
        
        // Se já tiver mensagem formatada, usar diretamente
        let finalMessage = message;
        
        // Se não tiver mensagem mas tiver dados do pedido, formatar
        if (!finalMessage && order) {
            finalMessage = formatOrderMessage(event, order, customer);
        }
        
        // Se ainda não tiver mensagem, criar fallback
        if (!finalMessage) {
            const eventLabels = {
                'order_created': '🍕 Pedido recebido',
                'order_preparing': '👩‍🍳 Pedido em preparo',
                'order_ready': '🚗 Pedido pronto para entrega',
                'order_completed': '✅ Pedido entregue',
            };
            
            const eventLabel = eventLabels[event] || '📦 Atualização do pedido';
            finalMessage = `${eventLabel}\n\nPedido #${order?.number || order?.id || 'N/A'}`;
        }

        // Enviar mensagem
        const result = await sendMessage(targetPhone, finalMessage);
        
        logger.info('📩 Notificação enviada com sucesso', {
            event,
            order_id: order?.id,
            order_number: order?.number,
            phone: targetPhone,
            message_length: finalMessage.length
        });

        res.json({
            success: true,
            messageId: result.messageId,
            sent_at: new Date().toISOString()
        });

    } catch (error) {
        logger.error('❌ Erro ao processar notificação', {
            error: error.message,
            body: req.body
        });
        
        res.status(500).json({ 
            error: error.message,
            success: false
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

app.listen(PORT, () => {
    logger.info(`✅ Servidor rodando na porta ${PORT}`);
    logger.info(`📡 Endpoints disponíveis:`);
    logger.info(`   - GET  / (health check)`);
    logger.info(`   - POST /send-message (envio simples)`);
    logger.info(`   - POST /api/notify (notificações Laravel)`);
});
