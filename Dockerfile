FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app/data
ENV DATA_DIR=/app/data
USER node
EXPOSE 3000
CMD ["npm", "start"]
