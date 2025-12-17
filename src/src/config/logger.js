const pino = require('pino');

const logger = pino({
    level: 'info', // Nivel padrao
    // Baileys exige trace/debug, o Pino gerencia isso nativamente
    timestamp: () => `,"time":"${new Date().toISOString()}"`
});

module.exports = logger;
