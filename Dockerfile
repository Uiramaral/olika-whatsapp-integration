FROM docker.io/library/node:20-alpine@sha256:16858294071a56ffd4cce9f17b57136cc39e41507b40e245b4f8e906f7a19463

WORKDIR /app

# Instala git para o Baileys (é necessário para as dependências)
RUN apk add --no-cache git

# Garante que o diretório de credenciais existe e tem permissão de escrita
# (Corrigindo o problema de permissão que você identificou)
RUN mkdir -p /app/auth_info_baileys && chmod 777 /app/auth_info_baileys

# Declaração do Volume (Corrigindo a ausência que você apontou)
VOLUME ["/app/auth_info_baileys"]

COPY package*.json ./
RUN npm ci --only=production

COPY . .

CMD ["npm", "start"]
