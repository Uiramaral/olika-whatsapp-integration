/* eslint-disable no-console */
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const cron = require('node-cron');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 3000;
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN;
const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || '55';
const CRM_INACTIVE_ENDPOINT = process.env.CRM_INACTIVE_ENDPOINT || '';
const CRM_TOKEN = process.env.CRM_TOKEN || '';
const SESSION_FOLDER = process.env.SESSION_FOLDER || path.join(__dirname, 'session');
const LOG_LEVEL = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

if (!fs.existsSync(SESSION_FOLDER)) {
  fs.mkdirSync(SESSION_FOLDER, { recursive: true });
}

const logger = pino({
  level: LOG_LEVEL
});

const app = express();
app.use(helmet());
app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('combined'));

let sock;
let startPromise;
let connectionReady = false;
let readyResolvers = [];
let restarting = false;

const templates = {
  order_created: (ctx = {}) => {
    const order = ctx.order || {};
    const customer = ctx.customer || {};
    const items = buildItemsList(order.items || []);
    const total = formatCurrency(order.total);
    return [
      '✅ *Pedido confirmado!*',
      '',
      `Olá, ${customer.name || 'cliente'}! Recebemos o pedido *#${order.number || '-'}* e já estamos preparando tudo com carinho.`,
      '',
      '🧾 *Resumo do pedido:*',
      items,
      '',
      `💰 Total: ${total}`,
      '',
      'Assim que estiver pronto, avisamos por aqui. Obrigado pela preferência!'
    ].filter(Boolean).join('\n');
  },
  order_preparing: (ctx = {}) => [
    '👩‍🍳 *Pedido em preparo*',
    '',
    `Olá, ${ctx.customer?.name || 'cliente'}! Nosso time já está na cozinha cuidando do pedido *#${ctx.order?.number || '-'}*.`,
    'Avisamos quando estiver pronto!'
  ].join('\n'),
  order_ready: (ctx = {}) => [
    '🚚 *Pedido pronto!*',
    '',
    `O pedido *#${ctx.order?.number || '-'}* já está pronto ${(ctx.order?.delivery_type === 'pickup') ? 'para retirada' : 'e segue para o entregador'}.`,
    ctx.order?.notes ? `\n📝 Observações: ${ctx.order.notes}` : '',
    '\nObrigado por comprar com a Olika!'
  ].filter(Boolean).join('\n'),
  order_completed: (ctx = {}) => [
    '🎉 *Pedido entregue!*',
    '',
    `Esperamos que tenha gostado do pedido *#${ctx.order?.number || '-'}*.`,
    'Conta pra gente como foi a experiência. Até a próxima! 😋'
  ].join('\n'),
  customer_inactive: (ctx = {}) => [
    '🍞 *Sentimos sua falta por aqui!*',
    '',
    `Olá, ${ctx.customer?.name || 'cliente'}! Faz tempo que você não passa por aqui.`,
    'Temos novidades deliciosas esperando por você 😋'
  ].join('\n')
};

function buildItemsList(items = []) {
  if (!items.length) {
    return 'Itens não informados.';
  }

  return items.map((item) => {
    const qty = item.quantity ?? 1;
    const name = item.name ?? 'Item';
    const totalValue = item.total ?? ((item.unit_price ?? 0) * qty);
    const total = formatCurrency(totalValue);
    return `${qty}x ${name} — ${total}`;
  }).join('\n');
}

function formatCurrency(value = 0) {
  return Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(value) || 0);
}

function normalizePhone(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith(DEFAULT_COUNTRY_CODE)) {
    return digits;
  }
  return `${DEFAULT_COUNTRY_CODE}${digits}`;
}

async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    printQRInTerminal: false,
    auth: state,
    browser: ['Olika Bot', 'Chrome', '1.0.0'],
    logger
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      logger.info('Novo QRCode gerado. Escaneie para autenticar.');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      logger.info('WhatsApp conectado.');
      connectionReady = true;
      readyResolvers.forEach((resolve) => resolve());
      readyResolvers = [];
    } else if (connection === 'close') {
      connectionReady = false;
      const shouldReconnect =
        (lastDisconnect?.error?.output?.statusCode ?? 0) !== DisconnectReason.loggedOut;

      if (shouldReconnect && !restarting) {
        logger.warn('Conexão perdida. Tentando reconectar em 3s...');
        restarting = true;
        setTimeout(() => {
          restarting = false;
          startPromise = startSocket().catch((err) => {
            logger.error({ err }, 'Erro ao recriar sessão');
          });
        }, 3000);
      } else if (!shouldReconnect) {
        logger.error('Sessão encerrada. Apague o diretório /session para reautenticar.');
      }
    }
  });

  return sock;
}

async function ensureSocket() {
  if (sock) {
    return sock;
  }

  if (!startPromise) {
    readyResolvers = [];
    connectionReady = false;
    startPromise = startSocket();
  }

  return startPromise;
}

function waitForConnection() {
  if (connectionReady) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    readyResolvers.push(resolve);
  });
}

async function sendWhatsApp(to, message) {
  await ensureSocket();
  await waitForConnection();

  const jid = `${to}@s.whatsapp.net`;
  logger.debug({ to: jid }, 'Enviando mensagem');
  await sock.sendMessage(jid, { text: message });
}

function resolveTemplate(payload) {
  if (payload.message) {
    return payload.message;
  }

  const builder = templates[payload.event];

  if (!builder) {
    return `Status do pedido #${payload.order?.number ?? ''}: ${payload.status ?? payload.event}`;
  }

  return builder(payload);
}

function validateAuth(req, res) {
  if (!WEBHOOK_TOKEN) {
    return true;
  }

  const token = req.header('x-olika-token');
  if (token && token === WEBHOOK_TOKEN) {
    return true;
  }

  res.status(401).json({ error: 'unauthorized' });
  return false;
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    connected: connectionReady,
    sessionPath: SESSION_FOLDER
  });
});

app.post('/api/notify', async (req, res) => {
  if (!validateAuth(req, res)) {
    return;
  }

  const payload = req.body || {};
  const { customer, order } = payload;

  if (!customer?.phone || !payload.event) {
    res.status(422).json({ error: 'payload inválido' });
    return;
  }

  const phone = normalizePhone(customer.phone);

  if (!phone) {
    res.status(422).json({ error: 'telefone inválido' });
    return;
  }

  try {
    const message = resolveTemplate(payload);
    await sendWhatsApp(phone, message);

    logger.info({
      event: payload.event,
      order: order?.number,
      phone
    }, 'Mensagem enviada.');

    res.json({ ok: true });
  } catch (error) {
    logger.error({ err: error }, 'Falha ao enviar mensagem.');
    res.status(500).json({ error: 'Falha ao enviar mensagem' });
  }
});

async function fetchInactiveCustomers() {
  if (!CRM_INACTIVE_ENDPOINT) {
    logger.debug('Endpoint de clientes inativos não configurado.');
    return [];
  }

  try {
    const response = await axios.get(CRM_INACTIVE_ENDPOINT, {
      timeout: 10000,
      headers: CRM_TOKEN
        ? { Authorization: `Bearer ${CRM_TOKEN}` }
        : undefined
    });

    const data = response.data;
    if (Array.isArray(data)) {
      return data;
    }
    if (Array.isArray(data?.data)) {
      return data.data;
    }
    return [];
  } catch (error) {
    logger.error({ err: error }, 'Erro ao buscar clientes inativos.');
    return [];
  }
}

async function sendInactiveReminders() {
  const clientes = await fetchInactiveCustomers();

  if (!clientes.length) {
    return;
  }

  logger.info({ total: clientes.length }, 'Enviando lembretes para clientes inativos.');

  for (const cliente of clientes) {
    const phone = normalizePhone(cliente.phone);
    if (!phone) continue;

    const message = templates.customer_inactive({
      customer: { name: cliente.name ?? 'Cliente' }
    });

    try {
      await sendWhatsApp(phone, message);
    } catch (error) {
      logger.warn({ err: error, phone }, 'Falha ao enviar lembrete para cliente inativo.');
    }
  }
}

cron.schedule('0 10 * * *', () => {
  logger.info('Executando rotina diária de clientes inativos.');
  sendInactiveReminders()
    .then(() => logger.info('Rotina diária concluída.'))
    .catch((err) => logger.error({ err }, 'Erro na rotina diária.'));
}, {
  timezone: process.env.CRON_TIMEZONE || 'America/Sao_Paulo'
});

app.use((err, req, res, next) => {
  logger.error({ err }, 'Erro não tratado.');
  res.status(500).json({ error: 'unexpected_error' });
});

app.listen(PORT, () => {
  logger.info(`Olika WhatsApp bot rodando na porta ${PORT}`);
});

ensureSocket().catch((err) => {
  logger.error({ err }, 'Erro ao iniciar sessão WhatsApp');
});

