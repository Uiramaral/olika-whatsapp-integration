# 🎭 Guia de Injeção de Contexto - IA Generativa

> **STATUS (2026-09): DOC HISTÓRICO/DESATUALIZADO.** Arquitetura real: gateway **Baileys/Railway**, IA **DeepSeek no Laravel**, persona **Pedro** (não "Oli"), endpoint real de contexto `/api/whatsapp/context` (não `/api/customer-context`), **sem transcrição de áudio**.

Este documento descreve como configurar a personalidade da IA e injetar contexto dinâmico do cliente no sistema.

## 📋 Arquitetura de Contexto

O sistema utiliza dois tipos de contexto para personalizar as respostas da IA:

### 1. 🎭 Contexto Estático (Persona da IA)
Personalidade e regras fundamentais da IA, definidas uma vez e aplicadas a todas as conversas.

### 2. 📋 Contexto Dinâmico (Dados do Cliente)
Informações atualizadas do cliente (pedidos, status, fidelidade) buscadas em tempo real do banco de dados.

---

## 🎭 1. Contexto Estático (Persona da Olika)

### O que é?
O script principal que define a personalidade, tom de voz, missão e regras da IA.

### Como Configurar?

#### Opção 1: Variável de Ambiente no Railway (Recomendado)

No painel do Railway, adicione:

```bash
AI_SYSTEM_PROMPT="Você é o Oli, assistente virtual da Olika Pizza. Seu tom é profissional mas caloroso, como um parceiro que realmente se importa. Sua missão é ajudar os clientes com pedidos, dúvidas sobre o cardápio, status de entregas e informações sobre promoções. Você NÃO deve inventar produtos que não existem, fazer promessas sobre prazos sem confirmar, ou compartilhar informações financeiras sensíveis. Se não souber algo, seja honesto e sugira que o cliente entre em contato com o suporte."
```

#### Opção 2: Usar o Padrão (Fallback)

Se não configurar a variável, o sistema usa:
```
"Você é um assistente profissional da Olika, otimizado para custo. Sua análise é baseada APENAS no texto que você recebe. Se houver mídia que não pôde ser processada, avise o usuário educadamente."
```

### 📝 Exemplo de Script Personalizado

```text
Você é o Oli, assistente virtual da Olika Pizza.

PERSONALIDADE:
- Tom profissional mas caloroso
- Comunicativo e prestativo
- Empático com problemas do cliente

MISSÃO:
- Ajudar com pedidos e dúvidas sobre cardápio
- Informar status de entregas
- Divulgar promoções e ofertas
- Resolver problemas de forma eficiente

REGRAS:
- NÃO invente produtos que não existem
- NÃO faça promessas sobre prazos sem confirmar
- NÃO compartilhe informações financeiras sensíveis
- Se não souber algo, seja honesto e sugira contato com suporte
- Use os dados do contexto do cliente quando disponíveis

FORMATO:
- Seja conciso mas completo
- Use emojis com moderação
- Mantenha tom profissional mas amigável
```

---

## 📋 2. Contexto Dinâmico (Dados do Cliente)

### O que é?
Informações atualizadas do cliente buscadas do banco de dados em tempo real e injetadas no prompt.

### Como Funciona?

1. **Cliente envia mensagem** → Node.js capta o número
2. **Node.js consulta Laravel** → POST `/api/customer-context` com o número
3. **Laravel busca no banco** → Retorna JSON com dados do cliente
4. **Node.js formata contexto** → Injeta no prompt antes da mensagem do usuário

### Dados Retornados

O endpoint `/api/customer-context` retorna:

```json
{
  "name": "João Silva",
  "has_customer": true,
  "last_order": "456",
  "last_order_status": "preparing",
  "last_order_total": "85.50",
  "total_orders": 12,
  "loyalty_points": 150
}
```

### Como Configurar?

No Railway, adicione:

```bash
CUSTOMER_CONTEXT_URL=https://devdashboard.menuolika.com.br/api/customer-context
```

⚠️ **IMPORTANTE**: Deve usar o mesmo `WH_API_TOKEN` configurado para autenticação.

### Exemplo de Contexto Injetado

Antes da mensagem do usuário, o sistema adiciona:

```
[CONTEXTO DO CLIENTE: Nome: João Silva, Último Pedido: #456 (Status: preparing), Total de Pedidos: 12, Pontos de Fidelidade: 150]

[Mensagem do Usuário]: Qual o status do meu pedido?
```

---

## 🔧 Variáveis de Ambiente Necessárias

### Railway (Node.js)

```bash
# Contexto Estático (Persona)
AI_SYSTEM_PROMPT="Você é o Oli, assistente virtual da Olika Pizza..."

# Contexto Dinâmico (Cliente)
CUSTOMER_CONTEXT_URL=https://devdashboard.menuolika.com.br/api/customer-context

# Token de Autenticação (já configurado)
WH_API_TOKEN=seu_token_secreto_aqui
```

---

## 📝 Exemplo de Prompt Final

Com ambos os contextos configurados, o prompt enviado para a OpenAI será:

```
System: "Você é o Oli, assistente virtual da Olika Pizza. Seu tom é profissional mas caloroso..."

User: "[CONTEXTO DO CLIENTE: Nome: João Silva, Último Pedido: #456 (Status: preparing), Total de Pedidos: 12, Pontos de Fidelidade: 150]

[Mensagem do Usuário]: Qual o status do meu pedido?"
```

---

## ✅ Benefícios

### Contexto Estático:
- ✅ Personalidade consistente
- ✅ Regras de negócio aplicadas
- ✅ Fácil ajuste sem alterar código
- ✅ Configurável por ambiente

### Contexto Dinâmico:
- ✅ Respostas personalizadas
- ✅ Informações atualizadas
- ✅ Melhor experiência do cliente
- ✅ IA conhece histórico do cliente

---

## 🔍 Testes

### 1. Testar Contexto Estático:

Verifique se a IA responde com a personalidade configurada:

```
Cliente: "Olá"
IA: [Deve responder como "Oli", com tom profissional mas caloroso]
```

### 2. Testar Contexto Dinâmico:

Verifique se a IA usa informações do cliente:

```
Cliente: "Qual o status do meu pedido?"
IA: [Deve mencionar o pedido #456 com status "preparing"]
```

---

## ⚙️ Troubleshooting

### IA não está usando a personalidade:
- Verificar se `AI_SYSTEM_PROMPT` está configurada no Railway
- Verificar logs do Node.js para ver qual prompt está sendo usado

### Contexto do cliente não aparece:
- Verificar se `CUSTOMER_CONTEXT_URL` está configurada
- Testar endpoint manualmente: `curl -X POST ...`
- Verificar logs para erros na busca de contexto

### Cliente não encontrado:
- Normal: Se o cliente não estiver cadastrado, o contexto será vazio
- A IA continuará funcionando normalmente sem contexto

---

## 📚 Próximos Passos

1. ✅ Configure `AI_SYSTEM_PROMPT` no Railway
2. ✅ Configure `CUSTOMER_CONTEXT_URL` no Railway
3. ✅ Teste com mensagens reais
4. ✅ Ajuste o script da persona conforme necessário

Sistema pronto para personalização completa da IA! 🚀

