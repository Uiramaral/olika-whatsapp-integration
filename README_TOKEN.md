# 🔑 Script para Obter Token Railway

## 🚀 Uso Rápido

```bash
cd olika-whatsapp-integration
npm run get-token
```

---

## ⚠️ Importante: Tipos de Token

### Token CLI (rwsk_) - Este Script
- **Formato**: `rwsk_xxxxxxxxxxxxx`
- **Uso**: Autenticação via Railway CLI
- **Como obter**: Execute `npm run get-token`

### Token API (RAILWAY_API_KEY) - Para Laravel
- **Formato**: UUID (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)
- **Uso**: GraphQL API do Railway (usado em `RailwayService.php`)
- **Como obter**: Railway Dashboard → Settings → API Tokens → Create Token

**⚠️ Atenção**: O token CLI (`rwsk_`) **NÃO** funciona como `RAILWAY_API_KEY` no Laravel.

---

## 📋 Pré-requisitos

1. **Instalar Railway CLI**:
   ```bash
   npm install -g @railway/cli
   ```

2. **Autenticar**:
   ```bash
   railway login
   ```

3. **Executar script**:
   ```bash
   npm run get-token
   ```

---

## 📁 Arquivos

- `scripts/getRailwayToken.js` - Script principal
- `.railway_token` - Token salvo (gerado automaticamente, não commitar!)

---

**Mais detalhes em**: `RAILWAY_TOKEN_SCRIPT.md`

