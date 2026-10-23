FROM node:22-alpine
WORKDIR /app
COPY . .
RUN npm ci
ENV NODE_ENV=production PORT=4000
EXPOSE 4000
USER node
CMD ["node", "index.js"]
