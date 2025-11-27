FROM node:20-alpine

# Instalar Git (necessário para algumas dependências)
RUN apk add --no-cache git

WORKDIR /app

COPY package*.json ./

# Instalação limpa das dependências
RUN npm ci --only=production

COPY . .

EXPOSE 3000

CMD ["npm", "start"]
