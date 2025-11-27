require('dotenv').config();
const express = require('express');
const { sendMessage } = require('./services/socket');
const logger = require('./config/logger');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.API_SECRET; 

// Middleware de Segurança
app.use((req, res, next) => {
    const token = req.headers['x-api-token'];
    // Se não tiver API_SECRET definido no env, bloqueia tudo por segurança
    if (!API_TOKEN) {
        logger.error('ERRO CRÍTICO: API_SECRET não configurado no .env');
        return res.status(500).json({ error: 'Configuração de servidor inválida' });
    }

    if (token === API_TOKEN) {
        next();
    } else {
        logger.warn(`Tentativa de acesso negado. Token recebido: ${token}`);
        res.status(403).json({ error: 'Acesso negado' });
    }
});

app.get('/', (req, res) => {
    res.send('Olika WhatsApp Gateway is Running ');
});

app.post('/send-message', async (req, res) => {
    try {
        const { number, message } = req.body;
        
        if (!number || !message) {
            return res.status(400).json({ error: 'Campos obrigatórios: number, message' });
        }

        const result = await sendMessage(number, message);
        logger.info(`Mensagem enviada para ${number}`);
        res.json(result);

    } catch (error) {
        logger.error(`Erro no envio: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    logger.info(` Servidor rodando na porta ${PORT}`);
});
