FROM docker.io/library/node:20-alpine@sha256:16858294071a56ffd4cce9f17b57136cc39e41507b40e245b4f8e906f7a19463

WORKDIR /app

# Instala git para o Baileys
RUN apk add --no-cache git

# Garante que o diretório de credenciais existe ANTES de copiar o código.
RUN mkdir -p /app/auth_info_baileys 

COPY package*.json ./
RUN npm ci --only=production

COPY . .

CMD ["npm", "start"]
