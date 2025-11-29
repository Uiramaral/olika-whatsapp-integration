require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { startSock, sendMessage, isConnected, disconnect } = require('./services/socket');
const logger = require('./config/logger');

const app = express();
app.use(cors());
app.use(express.json());

// Railway usa porta 8080 por padrão - usar ?? em vez de || para não tratar 0 como falsy
const PORT = process.env.PORT ?? 8080;
const API_TOKEN = process.env.API_SECRET;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || API_TOKEN; // Fallback para API_SECRET se WEBHOOK_TOKEN não estiver definido

// Variável global para armazenar QR Code atual
global.currentQR = null;
global.currentQRTimestamp = null; // Timestamp de quando o QR Code foi gerado
global.currentPairingCode = null; // Código numérico de pareamento

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

// Endpoint para obter status da conexão WhatsApp
app.get('/api/whatsapp/status', requireAuth, (req, res) => {
    try {
        const sock = global.sock;
        const user = sock?.user;
        const connected = isConnected();
        
        // Retornar código de pareamento apenas se não estiver conectado
        const pairingCode = connected ? null : (global.currentPairingCode || null);
        
        res.json({
            connected: connected,
            pairingCode: pairingCode,
            user: user ? {
                id: user.id,
                name: user.name || null
            } : null,
            last_updated: new Date().toISOString()
        });
    } catch (error) {
        logger.error('Erro ao obter status:', error);
        res.status(500).json({
            connected: false,
            error: 'Erro ao obter status'
        });
    }
});

// Endpoint para desconectar WhatsApp manualmente
app.post('/api/whatsapp/disconnect', requireAuth, async (req, res) => {
    try {
        const result = await disconnect();
        
        if (result.success) {
            logger.info('🔴 WhatsApp desconectado manualmente via API');
            res.json({
                success: true,
                message: result.message
            });
        } else {
            res.status(400).json({
                success: false,
                message: result.message
            });
        }
    } catch (error) {
        logger.error('Erro ao desconectar WhatsApp:', error);
        res.status(500).json({
            success: false,
            error: 'Erro ao desconectar WhatsApp'
        });
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
// O app.listen retorna o objeto Server - precisamos capturá-lo para graceful shutdown
server = app.listen(PORT, '0.0.0.0', () => {
    logger.info(`✅ Servidor HTTP rodando na porta ${PORT} (host: 0.0.0.0)`);
    logger.info(`📡 Endpoints disponíveis:`);
    logger.info(`   - GET  / (health check)`);
    logger.info(`   - POST /send-message (envio simples)`);
    logger.info(`   - POST /api/notify (notificações Laravel)`);
    
    // 🔌 Iniciar Baileys em segundo plano (não bloqueia o Express)
    // Usar setImmediate para garantir que o servidor já está totalmente ativo
    setImmediate(() => {
        logger.info(`🔄 Iniciando conexão WhatsApp em segundo plano...`);
        startSock().catch(err => {
            logger.error('❌ Erro ao iniciar WhatsApp (continuando sem WhatsApp):', err.message);
            // Não encerra o servidor - o Express continua funcionando
        });
    });
});
