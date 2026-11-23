FROM node:26-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY casino ./casino
RUN mkdir /data && chown node:node /data
USER node
ENV CASINO_HOST=0.0.0.0 CASINO_DATA_DIR=/data PORT=4010
EXPOSE 4010
CMD ["npm", "start"]
