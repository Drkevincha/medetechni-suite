# Imagen base de Node.js
FROM node:18-alpine

# Directorio de trabajo dentro del contenedor
WORKDIR /app

# Copiamos los archivos de dependencias
COPY package*.json ./

# Instalamos dependencias en modo producción
RUN npm install --production

# Copiamos el resto de la app
COPY . .

# Definimos el puerto (Cloud Run usa 8080)
ENV PORT=8080
EXPOSE 8080

# Comando de inicio
CMD ["node", "server.js"]
