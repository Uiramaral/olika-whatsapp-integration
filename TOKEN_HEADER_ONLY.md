# Token de integração: somente por cabeçalho

A partir desta change, o Laravel **não autentica** mais token enviado por query string (`?token=...`) ou no corpo JSON/formulário.

## Como enviar

Use um destes cabeçalhos:

```http
X-API-Token: <token>
apikey: <token>
Authorization: Bearer <token>
```

Exemplo:

```bash
curl -X POST "https://devdashboard.menuolika.com.br/api/whatsapp/ia/status" \
  -H "X-API-Token: $WH_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phone":"5571987019420"}'
```

## Regras

- O token deve ser idêntico ao `chave_api` da instância/configuração no Laravel.
- Não coloque o token em URL, histórico de navegador, logs ou corpo de formulário.
- Rotação: atualize o valor nos dois lados (Laravel e gateway) na mesma janela; o valor antigo deixa de autenticar imediatamente.
- O `chave_api` continua armazenado como está porque é usado nas chamadas de saída ao gateway. Criptografia em repouso fica para uma change futura com plano de rotação.
