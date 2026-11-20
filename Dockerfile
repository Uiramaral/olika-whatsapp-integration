FROM docker.io/library/node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

WORKDIR /app

# Instala git para o Baileys
RUN apk add --no-cache git

# Garante que o diretório de credenciais existe ANTES de copiar o código.
# Monte um volume do Railway em /app/auth_info_baileys para a sessão sobreviver
# a deploys/reinícios. Sem volume, todo deploy exige novo pareamento.
RUN mkdir -p /app/auth_info_baileys

COPY package*.json ./
# O postinstall (patch do ACK do Baileys) precisa existir antes do npm ci.
COPY scripts/patch-baileys.js ./scripts/patch-baileys.js
RUN npm ci --only=production

# Instala Railway CLI globalmente para uso de scripts
RUN npm install -g @railway/cli

COPY . .

# Falha o build se o patch do ACK não estiver aplicado (proteção contra upgrade
# do Baileys que mude o âncora). Ver scripts/patch-baileys.js.
RUN node scripts/patch-baileys.js --check

CMD ["npm", "start"]
