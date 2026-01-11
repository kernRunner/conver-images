FROM node:20-alpine

RUN apk add --no-cache libc6-compat

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "index.mjs"]
