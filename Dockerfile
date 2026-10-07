FROM node:18-bullseye-slim

# Instala o FFmpeg nativo completo com todas as bibliotecas de áudio e vídeo
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .

EXPOSE 8080
CMD ["npm", "start"]