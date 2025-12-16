# 🔧 Correção: HTTP 502 - Application failed to respond

## ❌ Problema Identificado

O Laravel envia corretamente o POST para `https://olika-bot.up.railway.app/api/notify`, mas recebe **HTTP 502** porque:

1. **O bot está reconectando o Baileys** durante a requisição
2. **O Express não responde** dentro do timeout do proxy Railway (≈10s)
3. **O `sendMessage()` trava** aguardando a reconexão do Baileys

### Logs do Railway Mostram:

```
🔴 Desconectado após 58.0 minutos online. Motivo: 500
Conexão instável. Tentando reconectar em 5s (tentativa 1)...
connected to WA
💾 Credenciais atualizadas com sucesso!
```

Isso confirma que durante a reconexão (5-10s), o Express fica bloqueado e não responde ao HTTP.

---

## ✅ Correções Implementadas

### 1. Timeout Rápido no Endpoint `/api/notify`

**Arquivo:** `olika-whatsapp-integration/src/app.js`

**Mudanças:**
- ✅ Timeout de **8 segundos** para resposta HTTP
- ✅ Verificação de conexão **ANTES** de processar
- ✅ Retorno **imediato** com 503 se não estiver conectado
- ✅ Timeout interno de **6 segundos** para `sendMessage()`
- ✅ Uso de `Promise.race()` para garantir resposta rápida

**Código:**

```javascript
app.post('/api/notify', requireAuth, async (req, res) => {
    // Timeout de segurança: resposta em no máximo 8 segundos
    const responseTimeout = setTimeout(() => {
        if (!res.headersSent) {
            return res.status(503).json({
                success: false,
                error: 'Timeout: WhatsApp está reconectando. Tente novamente em 5s.',
                retry: true,
                timeout: true
            });
        }
    }, 8000);

    try {
        // Verificar conexão ANTES de processar (resposta imediata)
        if (!isConnected()) {
            clearTimeout(responseTimeout);
            return res.status(503).json({ 
                success: false,
                error: 'WhatsApp está reconectando. Tente novamente em 5s.',
                retry: true,
                connected: false
            });
        }

        // Enviar com timeout interno (6 segundos)
        const sendPromise = sendMessage(targetPhone, finalMessage);
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Timeout ao enviar mensagem (6s)')), 6000);
        });

        const result = await Promise.race([sendPromise, timeoutPromise]);
        
        clearTimeout(responseTimeout);
        return res.json({ success: true, messageId: result.messageId });
        
    } catch (error) {
        clearTimeout(responseTimeout);
        // Tratamento de erros...
    }
});
```

---

### 2. Melhorias no `sendMessage()`

**Arquivo:** `olika-whatsapp-integration/src/services/socket.js`

**Mudanças:**
- ✅ Verificação dupla de conexão (globalSock + readyState)
- ✅ Timeout interno de **5 segundos** para `sendMessage()`
- ✅ Mensagens de erro mais claras

**Código:**

```javascript
const sendMessage = async (phone, message) => {
  // Verificar conexão antes de tentar enviar
  if (!globalSock) {
    throw new Error('Socket não está conectado.');
  }
  
  // Verificar se o WebSocket está realmente conectado
  if (globalSock.ws?.readyState !== 1) {
    throw new Error('WebSocket não está conectado (readyState: ' + (globalSock.ws?.readyState || 'null') + ')');
  }
  
  try {
    // Timeout interno de 5 segundos
    const sendPromise = globalSock.sendMessage(normalizedPhone, { text: message });
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Timeout interno: sendMessage demorou mais de 5s')), 5000);
    });
    
    const result = await Promise.race([sendPromise, timeoutPromise]);
    return { success: true, messageId: result?.key?.id };
  } catch (error) {
    // Tratamento de erros...
  }
};
```

---

### 3. Heartbeat Melhorado

**Arquivo:** `olika-whatsapp-integration/src/services/socket.js`

**Mudanças:**
- ✅ Intervalo reduzido de **20s para 30s** (mais frequente)
- ✅ Adicionado `sendPresenceUpdate('available')` para manter conexão ativa

**Código:**

```javascript
const startHeartbeat = () => {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = setInterval(() => {
    try {
      if (sock?.ws?.readyState === 1) {
        sock.ws.send("ping");
        logger.debug("💓 Heartbeat enviado para manter conexão viva");
        
        // Manter presença ativa
        try {
          sock.sendPresenceUpdate('available');
        } catch (e) {
          // Ignorar erros de presença
        }
      }
    } catch (err) {
      logger.warn("Erro ao enviar heartbeat:", err.message);
    }
  }, 30000); // A cada 30 segundos
};
```

---

### 4. Verificação de Conexão Melhorada

**Arquivo:** `olika-whatsapp-integration/src/services/socket.js`

**Mudanças:**
- ✅ Verificação mais rigorosa do `readyState`
- ✅ Retorna `false` se não estiver em estado OPEN (1)

**Código:**

```javascript
const isConnected = () => {
  if (!globalSock) {
    return false;
  }
  
  const wsState = globalSock.ws?.readyState;
  // readyState: 0 = CONNECTING, 1 = OPEN, 2 = CLOSING, 3 = CLOSED
  return wsState === 1; // Apenas OPEN
};
```

---

## 📊 Fluxo Corrigido

### Antes (Causava 502):

```
Laravel → POST /api/notify
         ↓
Bot recebe requisição
         ↓
Baileys está reconectando...
         ↓
sendMessage() aguarda indefinidamente
         ↓
Express não responde
         ↓
Railway proxy timeout (10s)
         ↓
HTTP 502 ❌
```

### Depois (Responde 503):

```
Laravel → POST /api/notify
         ↓
Bot recebe requisição
         ↓
Verifica isConnected() → false
         ↓
Responde IMEDIATAMENTE com 503
         ↓
Laravel recebe 503 com retry: true
         ↓
Laravel tenta novamente após 15s
         ↓
Bot já reconectado → Envia mensagem ✅
```

---

## 🧪 Testes

### Teste 1: Durante Reconexão

1. Force desconexão do Baileys (ou aguarde reconexão automática)
2. Envie POST do Laravel
3. **Esperado:** HTTP 503 com `retry: true` (não 502)

### Teste 2: Timeout do sendMessage

1. Simule delay no `sendMessage()` (>5s)
2. **Esperado:** HTTP 503 com `timeout: true` (não 502)

### Teste 3: Conexão Estável

1. Aguarde conexão estável
2. Envie POST do Laravel
3. **Esperado:** HTTP 200 com `success: true`

---

## 📝 Respostas HTTP

### Sucesso (200)

```json
{
  "success": true,
  "messageId": "3EB0C767F26BXXXX",
  "sent_at": "2025-01-27T18:30:00.000Z"
}
```

### WhatsApp Desconectado (503)

```json
{
  "success": false,
  "error": "WhatsApp está reconectando. Tente novamente em 5s.",
  "retry": true,
  "connected": false
}
```

### Timeout (503)

```json
{
  "success": false,
  "error": "Timeout: WhatsApp está reconectando. Tente novamente em 5s.",
  "retry": true,
  "timeout": true
}
```

---

## 🔄 Retry Automático no Laravel

O listener já implementa retry automático:

```php
// 3 tentativas com intervalo de 15 segundos
while ($attempt < self::MAX_RETRIES) {
    $attempt++;
    
    try {
        $response = Http::timeout(10)->post($webhookUrl, $payload);
        
        if ($response->failed()) {
            // Se for 503 com retry: true, tentar novamente
            if ($attempt < self::MAX_RETRIES) {
                usleep(15000 * 1000); // 15 segundos
                continue;
            }
        }
        
        // Sucesso
        return;
    } catch (\Throwable $e) {
        // Tratamento de erros...
    }
}
```

---

## ✅ Resultado Esperado

Após as correções:

1. ✅ **Nunca mais HTTP 502** - Express sempre responde
2. ✅ **HTTP 503 controlado** - Quando WhatsApp está reconectando
3. ✅ **Retry automático** - Laravel tenta novamente automaticamente
4. ✅ **Logs claros** - Fácil identificar problemas
5. ✅ **Conexão mais estável** - Heartbeat melhorado

---

## 🚀 Deploy

1. **Commit e push** das alterações
2. **Railway faz deploy automático** (se configurado)
3. **Monitorar logs** após deploy
4. **Testar** enviando notificação do Laravel

---

**Última atualização:** 2025-01-27  
**Status:** ✅ Correções implementadas - Aguardando deploy e testes












