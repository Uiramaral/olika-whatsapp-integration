# Segurança e Push Protection

Este repositório utiliza os mecanismos de _secret scanning_ e _push protection_ do GitHub. Para evitar bloqueios em deploys:

1. **Nunca versione arquivos `.env`, `session/` ou exports de tokens.**
2. **Use secrets** no GitHub Actions (`RAILWAY_TOKEN`) e variáveis no Railway ao invés de arquivos locais.
3. **Antes de `git add .`**, rode `git status --ignored` e confirme que nenhum `.env` entrou por engano.

## Caso um segredo vaze

1. **Revogue o token** no provedor (ex.: gere novo token no Railway).
2. **Remova do histórico** com `git filter-repo --path "<arquivo>" --invert-paths`.
3. **Force push** (`git push -f origin main`) para substituir o histórico seguro.
4. **Somente libere** o push via página “unblock secret” se o token já estiver invalidado.

Manter essa disciplina garante que o CI/CD para o Railway funcione sem interrupções e evita exposição de credenciais sensíveis.

