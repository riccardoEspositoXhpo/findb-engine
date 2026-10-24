FROM node:24-slim
ENV TZ=UTC

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

CMD ["node", "backend/jobs/dailyBatch.js"]