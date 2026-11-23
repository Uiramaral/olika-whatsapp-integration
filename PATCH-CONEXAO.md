# Correção da conexão do gateway WhatsApp

## O que foi corrigido

### 1. ACK de mensagem recebida (causa do ciclo de 50 minutos)

O Baileys 6.7.20 removeu o envio do `<ack class="message">` no caminho de sucesso
do `handleMessage`. O WhatsApp espera esse ACK por ~50 minutos e derruba o stream;
o Baileys traduz o erro para o código **500 (badSession)**, que não significa
sessão corrompida. O gateway reconectava em 3s e o ciclo se repetia para sempre.

- Referência: <https://github.com/WhiskeySockets/Baileys/issues/1910>
- Versão instalada: `7.0.0-rc14` (a última publicada; o `master` também não corrige
  o ACK de mensagem normal — o `sendMessageAck` que existe lá é só para newsletter).
- Correção: `scripts/patch-baileys.js` restaura `await sendMessageAck(node)` antes
  do `upsertMessage` em `node_modules/@whiskeysockets/baileys/lib/Socket/messages-recv.js`.
- O patch roda no `postinstall` e o Dockerfile executa `--check` depois do build.
  Se uma atualização do Baileys mudar o âncora, **o build falha** em vez de publicar
  sem a correção.

### 2. Sessão preservada no deploy

- `app.js` não chama mais `logout()` no SIGTERM. Agora `shutdownSocket()` encerra o
  socket com `end()`, preservando as credenciais. `logout()` desvincularia o aparelho
  a cada deploy.
- `disconnectSock()` também deixou de desvincular por padrão: `POST /api/whatsapp/disconnect`
  mantém o aparelho vinculado. Para desvincular de verdade, envie `{ "unlink": true }`
  no corpo (ou `?unlink=true`); nesse caso o gateway faz logout e apaga a sessão
  local, exigindo um novo pareamento.
- `forceLogout()` (usado por `/api/whatsapp/restart` e `/clear-auth`) agora faz o
  logout no WhatsApp antes de apagar a pasta, evitando dispositivo fantasma na lista
  do celular.

**Atenção:** o volume do Railway continua obrigatório. O código não consegue
persistir `/app/auth_info_baileys` sozinho. Sem o volume, todo deploy ainda perde a
sessão.

O `session_config.json` é o único arquivo fora da pasta da sessão. Ele pode
faltar por dois motivos: (a) o volume está montado na pasta da sessão
(`/app/auth_info_baileys/5571987019420`) em vez da pasta pai; ou (b) um reset
(`clear-auth`/logout) apagou o arquivo e o `startSock` não o recriou porque o
número em memória não mudou. O `startSock` agora recria o config sempre que ele
estiver ausente, e `loadConfig()` ainda tem o fallback que encontra a pasta com
`creds.json`. O caminho ideal do volume continua sendo `/app/auth_info_baileys`,
mas o mount atual funciona.

### 3. Robustez da reconexão

- **Geração do socket:** eventos de um socket antigo são ignorados; um socket novo
  não é mais derrubado pelo timer de reconexão do anterior.
- **Um timer por vez:** `scheduleReconnect()` cancela o timer pendente e agenda a
  próxima tentativa; nada de vários `startSock()` concorrentes.
- **Backoff com jitter:** 3s, 6s, 12s, 24s, 48s, 60s. Como a tentativa zera no
  `open`, o ciclo normal continua reconectando em ~3s.
- **440 (connectionReplaced):** espera 90s em vez de entrar em ping-pong com outra
  instância.
- **Conflito de sessão (`Stream Errored (conflict)`):** pode vir com code 401, mas
  **não é logout**. O gateway preserva as credenciais, alerta o Laravel e tenta
  de novo em 5 min. Se repetir, há outra instância usando a mesma sessão
  (deploy antigo ou réplica); verifique no Railway. O comportamento antigo apagava
  a pasta de sessão e forçava um novo pareamento.
- **Watchdog:** a cada 60s verifica `globalSock.ws.isOpen`; se o WebSocket morreu
  sem emitir `close`, chama `softRestart('watchdog-ws')`.
- **Versão do WhatsApp Web:** buscada uma vez por processo e com fallback para a
  versão padrão da biblioteca se a rede falhar no boot.
- **Diagnóstico real da queda:** o log agora mostra o motivo do `lastDisconnect`
  (`Stream Errored (ack)`, por exemplo) e o id do ACK, além do código. O
  `/api/whatsapp/diagnostics` expõe `lastDisconnect`, `reconnectAttempts` e `authDir`.
- **Pasta de auth:** o boot loga quantos arquivos existem em `auth_info_baileys` e
  avisa quando está vazia.

### 4. Chaves E2EE fora do log

`libsignal` imprime o `SessionEntry` completo (com `privKey`, `rootKey`, `chainKey`)
via `console.info`. `src/utils/log_filter.js` intercepta `process.stdout/stderr.write`
e descarta esses blocos. O pino silencioso não cobre esse caminho.

### 5. Mensagem presa (stream errored ack)

O log de 20/11 mostrou um caso diferente do ACK geral: o servidor cobrava o ACK de
**sempre o mesmo id** a cada ~50 min. Essa mensagem não aparece no
`messages.upsert` — ou seja, o Baileys não conseguiu descriptografá-la, mandou
retry/NACK e o servidor continuou com ela pendente. A correção do ACK de sucesso
não alcança esse caminho.

O gateway agora:

- guarda os metadados de cada `CB:message` (tag + attrs, **sem o conteúdo/mídia**)
  por 12h, até 10.000 mensagens;
- escuta `CB:stream:error` **antes** do Baileys encerrar o socket e extrai o id
  do ACK cobrado, logando também os `attrs` do `<ack>` e do nó pai;
- tenta liberar a mensagem imediatamente (se o nó estiver no cache) e, na próxima
  reentrega, envia o ACK de sucesso para o mesmo id — o servidor para de cobrar;
- se não houver nó bruto mas o `<ack>` trouxer `from`, tenta um ACK sintético;
- se não houver nó nem `from`, registra que não há como montar um ACK válido e
  aguarda a reentrega/expiração do servidor;
- registra no log o `from`/`type` da mensagem liberada.

Logs esperados:

```
🧩 [Baileys] Patch de ACK: aplicado
🩹 [ACK] Liberação de mensagem presa: ativa.
🧩 [ACK] Servidor cobrando ACK da mensagem id=... type=text | ackAttrs={...} | nodeAttrs={...}
🩹 [ACK] Tentativa imediata de liberar id=... from=...
🩹 [ACK] Mensagem presa liberada id=... from=... type=text (...). Se for um cliente, peça para reenviar.
```

Quando não há nó bruto:

```
🧩 [ACK] Sem nó bruto e sem "from" no <ack> para id=...; aguardando reentrega ou expiração do servidor. Não há como montar um ACK válido sem o remetente.
```

Flags:

- `ACK_STUCK_MESSAGES=false` desliga a liberação automática (o padrão é ativa
  quando o patch de ACK está aplicado).
- `DEBUG_RAW_MESSAGES=true` loga `id`, `from`, `type` e `participant` de cada
  mensagem bruta (útil para identificar a origem da mensagem presa).
- Se o patch de ACK não estiver na imagem, a liberação fica desativada
  automaticamente e o boot loga `Patch de ACK: AUSENTE`.

Trade-off: a mensagem presa já está indescritografável e perdida; o ACK só
destrava o servidor. O log traz o `from` para avisar o contato e pedir reenvio.
Quando o servidor não reentrega e o `<ack>` não traz `from`, não existe ACK
válido possível; o ciclo só termina quando o WhatsApp expira a pendência.

## Deploy

1. **Crie o volume no Railway** montado em `/app/auth_info_baileys` (serviço do
   gateway). Sem isso, o pareamento continua sendo perdido a cada deploy.
2. Faça o deploy normalmente. O build vai:
   - copiar `scripts/patch-baileys.js` antes do `npm ci`;
   - rodar o `postinstall`, que aplica o patch;
   - rodar `--check` e falhar se o patch não estiver presente.
3. Se o container já tinha sessão no volume, o log deve começar com:
   ```
   🔐 [Auth] Sessão em /app/auth_info_baileys/5571987019420 (N arquivo(s)).
   ✅ 5571987019420 CONECTADO!
   ```
   **Sem** `MODO STANDBY`. Se aparecer STANDBY, veja se a pasta da sessão existe
   no volume e se o `session_config.json` está presente; o fallback de
   `loadConfig` deve encontrar a pasta com `creds.json`.
4. Se ainda não houver sessão no volume, pareie uma última vez. A partir daí ela
   deve sobreviver aos deploys.

## Validação

- **ACK:** o ciclo de 500 a cada ~50 min causado por mensagens normais deve
  desaparecer. Se aparecer um 500 isolado com **sempre o mesmo id**, é uma
  mensagem presa (ver seção 5); o gateway a libera e o ciclo não deve se repetir.
- **Mensagem presa:** no próximo ciclo, o log deve mostrar o id, o `from`/`type`
  e a liberação. Se o mesmo id voltar depois de duas liberações, o ACK não está
  sendo aceito; envie o log para análise.
- **Motivo da queda:** em `GET /api/whatsapp/diagnostics`, `lastDisconnect.message`
  deve mostrar `Stream Errored (ack)` se o patch não estiver ativo. Se mostrar isso,
  confira no build se apareceu `[patch-baileys] ACK de mensagem restaurado`.
- **Sessão:** faça um deploy de teste e confirme que o log **não** mostra STANDBY e
  que nenhum código de pareamento foi solicitado.
- **Reconexão:** derrube a rede de propósito (ou use `POST /api/whatsapp/restart-session`)
  e confirme que volta em poucos segundos, com `reconnectAttempts` voltando a zero.

## Rollback

- Para desativar o patch: remova `postinstall` do `package.json`, remova o
  `RUN node scripts/patch-baileys.js --check` do Dockerfile e faça o deploy.
- Também é possível definir `BAILEYS_PATCH_OPTIONAL=1` para o build não falhar
  quando o âncora não for encontrado (não recomendado em produção).

## Observações

- `POST /api/whatsapp/disconnect` mudou de comportamento: agora **não** desvincula.
  O painel pode continuar usando a rota; o status vai para DESCONECTADO e o próximo
  `/connect` reaproveita a sessão. Para exigir novo pareamento, use
  `POST /api/whatsapp/clear-auth` (destrutivo) ou envie `unlink: true`.
- O log de `Closing session` que aparecia antes era ruído da libsignal; agora é
  filtrado. Ele não era a causa das quedas.
- Se o Baileys for atualizado, rode `npm run patch:check` antes de publicar. O
  `postinstall` reaplica o patch automaticamente; o `--check` garante que o build
  não passe sem ele.
