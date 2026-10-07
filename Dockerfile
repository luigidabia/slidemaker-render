FROM node:20-alpine

# Instala o FFmpeg nativo superleve, otimizado e sem erros de repositório
RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

EXPOSE 8080
CMD ["npm", "start"]
