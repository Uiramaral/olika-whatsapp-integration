# Olika WhatsApp Integration

Bot de notificações WhatsApp da Olika baseado em [Baileys](https://github.com/WhiskeySockets/Baileys), pensado para rodar 100% remoto no Railway e se comunicar com o Laravel via webhook.

## Estrutura

```
📦 olika-whatsapp-integration/
 ├── server.js        # Aplicação Express + Baileys
 ├── package.json     # Dependências e scripts
 ├── env.sample       # Variáveis de ambiente (copie para .env)
 ├── .gitignore       # Ignora node_modules, session e .env
 └── session/         # Pasta criada em runtime (NÃO versionar)
```

## Pré-requisitos

- Node.js 18.18+ (Railway já atende)
- Conta no GitHub com o repositório privado `Uiramaral/olika-whatsapp-integration`
- Projeto no [Railway](https://railway.app) conectado ao repositório

## Setup local/remoto

```bash
git clone https://github.com/Uiramaral/olika-whatsapp-integration.git
cd olika-whatsapp-integration
npm install
cp env.sample .env  # edite os valores
npm start
```

Durante o primeiro start será exibido um QR Code no terminal (ou nos logs do Railway). Escaneie com o WhatsApp Business da Olika e mantenha a sessão ativa.

## Variáveis de ambiente principais

| Variável | Descrição |
| --- | --- |
| `PORT` | Porta HTTP exposta (Railway usa automaticamente) |
| `WEBHOOK_TOKEN` | Token compartilhado com o Laravel (header `x-olika-token`) |
| `DEFAULT_COUNTRY_CODE` | Código do país usado ao normalizar telefones (padrão `55`) |
| `SESSION_FOLDER` | Diretório onde o Baileys salva as credenciais (não versionar) |
| `CRM_INACTIVE_ENDPOINT` | Endpoint opcional para buscar clientes inativos |
| `CRM_TOKEN` | Token/bearer usado no endpoint opcional |
| `CRON_TIMEZONE` | Timezone do agendamento diário (padrão `America/Sao_Paulo`) |

> **Importante:** mantenha `session/` e `.env` fora do Git para não vazar as credenciais do WhatsApp.

## Endpoints

- `GET /health` — status da aplicação e se o WhatsApp está conectado.
- `POST /api/notify` — Webhook chamado pelo Laravel.

### Payload esperado (`POST /api/notify`)

```json
{
  "event": "order_created",
  "status": "pending",
  "message": "Texto opcional para sobrescrever o template",
  "order": {
    "id": 123,
    "number": "2025-0001",
    "total": 129.9,
    "delivery_type": "delivery",
    "notes": "Sem cebola",
    "items": [
      { "name": "Pão levain", "quantity": 2, "total": 49.9 }
    ]
  },
  "customer": {
    "id": 88,
    "name": "João",
    "phone": "71999998888"
  }
}
```

O header `x-olika-token` deve conter o mesmo valor configurado em `WEBHOOK_TOKEN`.

## Deploy no Railway

1. Clique em **New Project → Deploy from GitHub** e escolha `Uiramaral/olika-whatsapp-integration`.
2. Configure as variáveis `PORT=3000`, `NODE_ENV=production`, `WEBHOOK_TOKEN=...`.
3. Acompanhe os logs para autenticar o WhatsApp via QR Code.
4. A URL gerada (ex.: `https://olika-bot.up.railway.app`) será usada no Laravel (`WHATSAPP_WEBHOOK_URL`).

## Integração com o Laravel

1. Defina no `.env` do Laravel:
   ```
   WHATSAPP_WEBHOOK_URL=https://olika-bot.up.railway.app/api/notify
   WHATSAPP_WEBHOOK_TOKEN=mesmo_token_do_bot
   WHATSAPP_DEFAULT_COUNTRY_CODE=55
   ```
2. Dispare `event(new \App\Events\OrderStatusUpdated($order, 'order_created'))` onde fizer sentido.
3. Os eventos suportados pelos templates padrão são:
   - `order_created`
   - `order_preparing`
   - `order_ready`
   - `order_completed`
   - `customer_inactive` (usado pelo cron interno)

O listener `SendOrderWhatsAppNotification` já prepara o payload e envia para o bot.

## Manutenção

| Comando | Local | Objetivo |
| --- | --- | --- |
| `npm run start` | Railway (Logs ou Shell) | Reinicia manualmente o bot |
| `npm update` | Railway | Atualiza dependências |
| `railway logs` | Railway Dashboard | Ver QR Code, erros e mensagens |
| `php artisan tinker` + `event(new OrderStatusUpdated(...))` | Servidor Laravel | Testa o webhook |

## Lembretes automáticos

O cron diário (`0 10 * * *`) chama `sendInactiveReminders()` que busca clientes inativos no endpoint configurado e envia mensagens usando o template `customer_inactive`. Sem endpoint configurado, o cron apenas registra nos logs.

## Segurança

- Nunca versione a pasta `session/` nem o arquivo `.env`.
- Use tokens fortes e, se possível, restrinja IPs do webhook no firewall/Railway.
- Monitore bloqueios do WhatsApp e limite envios em massa.

