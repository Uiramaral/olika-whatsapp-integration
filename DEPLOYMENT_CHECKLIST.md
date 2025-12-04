# 🚀 Checklist de Deploy - Sistema de IA WhatsApp

## ✅ Checklist Final de Deploy

### 1. Variáveis de Ambiente no Railway (Node.js)

Certifique-se de configurar todas as variáveis abaixo no painel do Railway:

```bash
# Controle de IA (Laravel)
AI_STATUS_URL=https://devdashboard.menuolika.com.br/api/ai-status
WH_API_TOKEN=seu_token_secreto_aqui

# OpenAI (Custo Otimizado)
OPENAI_API_KEY=sk-sua_chave_openai_aqui
OPENAI_MODEL=gpt-5-nano
OPENAI_TIMEOUT=30

# WhatsApp Gateway (se ainda não configurado)
WEBHOOK_URL=https://devdashboard.menuolika.com.br/api/whatsapp/webhook
API_SECRET=seu_token_secreto_aqui
```

⚠️ **CRÍTICO**: Configure `OPENAI_MODEL=gpt-5-nano` para otimização de custos.

### 2. Executar SQL no Laravel

Execute o arquivo SQL combinado para criar todas as estruturas necessárias:

```bash
mysql -u usuario -p banco_dados < database/sql/setup_ai_control_system.sql
```

Ou execute individualmente:
```bash
mysql -u usuario -p banco_dados < database/sql/add_ai_enabled_to_whatsapp_settings.sql
mysql -u usuario -p banco_dados < database/sql/create_ai_exceptions_table.sql
```

### 3. Configurar Token no Laravel (.env)

Adicione no arquivo `.env` do Laravel:

```bash
API_SECRET=seu_token_secreto_aqui
# ou
WH_API_TOKEN=seu_token_secreto_aqui
```

⚠️ **IMPORTANTE**: O token deve ser **EXATAMENTE O MESMO** configurado no Railway como `WH_API_TOKEN`.

### 4. Habilitar IA no Banco de Dados

Quando estiver pronto para ativar a IA:

```sql
UPDATE whatsapp_settings 
SET ai_enabled = TRUE 
WHERE active = 1;
```

Para desabilitar temporariamente:

```sql
UPDATE whatsapp_settings 
SET ai_enabled = FALSE 
WHERE active = 1;
```

### 5. Verificar Endpoint do Laravel

Teste o endpoint manualmente:

```bash
curl -X POST "https://devdashboard.menuolika.com.br/api/ai-status" \
  -H "X-API-Token: seu_token_secreto_aqui" \
  -H "Content-Type: application/json" \
  -d '{"phone": "5571987019420"}'
```

Resposta esperada:
```json
{
  "status": "enabled"
}
```

ou

```json
{
  "status": "disabled",
  "reason": "Global_Kill_Switch"
}
```

## 📦 Arquivos Prontos para Deploy

### Node.js (Railway):
- ✅ `src/app.js` - Servidor Express com timeout otimizado
- ✅ `src/services/socket.js` - Socket Baileys com cache e controle de IA
- ✅ `src/utils/ai_processor.js` - Processamento de mídia e transcrição
- ✅ `package.json` - Dependências atualizadas (openai, pdf-parse)

### Laravel:
- ✅ `app/Http/Controllers/AiStatusController.php` - Controller do endpoint
- ✅ `app/Http/Controllers/WhatsappInstanceController.php` - Transferência humana
- ✅ `routes/web.php` - Rota POST /api/ai-status
- ✅ `database/sql/setup_ai_control_system.sql` - SQL completo

## 🧪 Testes Pós-Deploy

### 1. Teste de Conectividade
- [ ] Verificar se o Gateway Node.js está rodando (GET /)
- [ ] Verificar status do WhatsApp (GET /api/whatsapp/status)

### 2. Teste de Controle de IA
- [ ] Enviar mensagem de texto → Deve processar com IA (se habilitada)
- [ ] Desabilitar IA no banco → Enviar mensagem → Não deve processar
- [ ] Enviar imagem → Deve criar exceção de 5 minutos

### 3. Teste de Mídia
- [ ] Enviar áudio → Deve transcrever e responder
- [ ] Enviar PDF → Deve extrair texto e resumir
- [ ] Enviar imagem → Deve acionar transferência humana

## 📊 Monitoramento

Acompanhe os logs no Railway para verificar:
- ✅ Cache HIT/MISS do status da IA
- ✅ Mensagens de erro ou sucesso
- ✅ Tempo de resposta das requisições
- ✅ Erros de transcrição ou processamento

## 🔧 Troubleshooting

### IA não está respondendo:
1. Verificar se `ai_enabled = TRUE` no banco
2. Verificar se `OPENAI_API_KEY` está configurada
3. Verificar logs do Railway para erros

### Erro 403 no endpoint /api/ai-status:
1. Verificar se o token está correto no `.env` do Laravel
2. Verificar se o token no Railway é o mesmo
3. Verificar header `X-API-Token` na requisição

### Cache não está funcionando:
- Normal: Primeira mensagem sempre faz chamada ao Laravel
- Cache de 30 segundos reduz chamadas subsequentes

## ✅ Status Final

- [x] Controller implementado
- [x] Rota configurada (POST)
- [x] Cache de status (30s)
- [x] Transferência humana para imagens/vídeos
- [x] Modelo padrão: gpt-5-nano
- [x] Timeout otimizado (6s)
- [x] Tratamento robusto de erros
- [x] SQL migrations prontos

**Sistema 100% pronto para produção! 🚀**

