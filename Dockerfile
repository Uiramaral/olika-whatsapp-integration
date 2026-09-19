FROM docker.io/library/node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

WORKDIR /app

# Instala git para o Baileys
RUN apk add --no-cache git

# Garante que o diret�rio de credenciais existe ANTES de copiar o c�digo.
RUN mkdir -p /app/auth_info_baileys 

COPY package*.json ./
RUN npm ci --only=production

# Instala Railway CLI globalmente para uso de scripts
RUN npm install -g @railway/cli

COPY . .

CMD ["npm", "start"]
