# 🚨 Configuração de Controle Condicional da IA

> **STATUS (2026-09): DOC HISTÓRICO/DESATUALIZADO.** Arquitetura real: gateway **Baileys/Railway** (Evolution **não implantado**), IA **DeepSeek no Laravel** (sem OpenAI/Whisper), **sem transcrição de áudio** (o agente avisa o cliente e notifica a equipe), persona **Pedro**, endpoints reais `/api/whatsapp/ia/status` e `/api/whatsapp/ia/responder` (não `/api/ai-status`).

Este documento descreve a implementação do sistema de controle condicional da IA, onde o Gateway Node.js consulta o estado do Laravel antes de processar mensagens com IA.

## 📋 Arquitetura

O sistema segue o princípio de **desacoplamento**, onde:
- O **Laravel (Dashboard)** é a única fonte de verdade para configurações
- O **Gateway Node.js** consulta o Laravel em tempo real antes de processar mensagens
- A decisão de habilitar/desabilitar a IA é centralizada no Laravel

## 🔧 Variáveis de Ambiente Necessárias

Adicione as seguintes variáveis de ambiente no Railway (ou seu ambiente de produção):

### Variáveis Obrigatórias

| Variável | Descrição | Exemplo de Valor |
|----------|-----------|------------------|
| `AI_STATUS_URL` | Endpoint completo no Laravel para consultar o status da IA | `https://seusistema.com/api/ai-status` |
| `WH_API_TOKEN` | Token secreto para autenticação na chamada POST acima | `SUA_CHAVE_SECRETA_UNICA` |
| `OPENAI_API_KEY` | Chave da API da OpenAI para processamento de IA e transcrição Whisper | `sk-...` |
| `OPENAI_MODEL` | Modelo da OpenAI a ser usado (padrão: `gpt-5-nano`) | `gpt-5-nano` (recomendado) ou `gpt-4o-mini` |
| `OPENAI_TIMEOUT` | Timeout em segundos para chamadas da OpenAI (padrão: `30`) | `30` |
| `AI_SYSTEM_PROMPT` | Script de personalidade da IA (persona) | Texto longo com instruções (opcional) |
| `CUSTOMER_CONTEXT_URL` | Endpoint para buscar contexto dinâmico do cliente | `https://devdashboard.menuolika.com.br/api/customer-context` |

### Exemplo de Configuração no Railway

```bash
AI_STATUS_URL=https://devdashboard.menuolika.com.br/api/ai-status
WH_API_TOKEN=seu_token_secreto_aqui
OPENAI_API_KEY=sk-sua_chave_openai_aqui
OPENAI_MODEL=gpt-5-nano
OPENAI_TIMEOUT=30

# Contexto Estático (Persona da IA) - Opcional
AI_SYSTEM_PROMPT="Você é o Oli, assistente virtual da Olika Pizza..."

# Contexto Dinâmico (Dados do Cliente) - Opcional
CUSTOMER_CONTEXT_URL=https://devdashboard.menuolika.com.br/api/customer-context
```

## 🔌 Contrato da API no Laravel

O Laravel deve implementar um endpoint que retorne o status da IA para um número de telefone específico.

### Endpoint: `POST /api/ai-status`

**Método:** POST (segurança aprimorada)

**Body (JSON):**
```json
{
  "phone": "5571987019420"
}
```

**Headers:**
- `X-API-Token`: Token de autenticação (deve corresponder a `WH_API_TOKEN`)
- `Content-Type`: `application/json`

**Resposta de Sucesso (IA Habilitada):**
```json
{
  "status": "enabled"
}
```

**Resposta de Sucesso (IA Desabilitada):**
```json
{
  "status": "disabled",
  "reason": "Global_Kill_Switch"
}
```

ou

```json
{
  "status": "disabled",
  "reason": "Exception_List"
}
```

### Implementação Sugerida no Laravel

O Laravel deve verificar:
1. **Flag Global**: `is_ai_enabled` na tabela de configurações
2. **Lista de Exceções**: Tabela `ai_exceptions` com números de telefone (JID) que devem ter a IA desabilitada

## 🔄 Fluxo de Processamento

1. **Mensagem Recebida**: O Gateway Node.js recebe uma mensagem via WhatsApp
2. **Verificação de Status**: Antes de processar, consulta `AI_STATUS_URL` com o número do remetente
3. **Decisão**:
   - Se `status === "disabled"`: Envia webhook apenas para LOG com flag `ai_disabled: true` e **não processa IA**
   - Se `status === "enabled"`: Continua com o processamento de IA
4. **Extração de Dados**: 
   - Texto: Processado diretamente
   - Áudio: Transcrito usando Whisper API
   - PDF: Extraído e resumido
   - Imagem/Vídeo: Apenas legenda processada
5. **Processamento de IA**: Chama OpenAI com o conteúdo extraído
6. **Resposta**: Envia resposta gerada pela IA diretamente ao usuário via WhatsApp

## 🛡️ Política de Segurança

- **Falha na Comunicação**: Se a consulta ao Laravel falhar (timeout, erro de rede, etc.), a IA é **automaticamente desabilitada** por segurança
- **URL Não Configurada**: Se `AI_STATUS_URL` não estiver configurada, a IA é **desabilitada por padrão**
- **Timeout Agressivo**: A consulta tem timeout de 5 segundos para não travar o fluxo de mensagens

## 📝 Logs

O sistema registra as seguintes informações:
- ✅ Quando a IA está habilitada para um número
- 🚫 Quando a IA está desabilitada (com motivo)
- ❌ Erros ao consultar o status no Laravel

## 🔍 Exemplo de Uso

Quando uma mensagem chega:

```javascript
// 1. Mensagem recebida: "Olá, quero fazer um pedido"
// 2. Gateway consulta: POST /api/ai-status { phone: "5571987019420" }
// 3. Laravel retorna: { "status": "enabled" }
// 4. Gateway processa com IA e responde diretamente ao usuário
```

Se a IA estiver desabilitada:

```javascript
// 1. Mensagem recebida: "Olá, quero fazer um pedido"
// 2. Gateway consulta: POST /api/ai-status { phone: "5571987019420" }
// 3. Laravel retorna: { "status": "disabled", "reason": "Global_Kill_Switch" }
// 4. Gateway envia webhook com ai_disabled: true (apenas para LOG)
// 5. Mensagem não é processada pela IA
```

## ⚠️ Importante

- O token `WH_API_TOKEN` deve ser o mesmo configurado no Laravel para autenticação
- O endpoint `AI_STATUS_URL` deve estar acessível e responder rapidamente (< 5 segundos)
- Em caso de falha na consulta, a IA é desabilitada por segurança (fail-safe)

