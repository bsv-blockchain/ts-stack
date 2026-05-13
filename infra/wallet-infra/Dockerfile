FROM node:22-alpine

# Install nginx
RUN echo "http://dl-4.alpinelinux.org/alpine/v3.3/main" >> /etc/apk/repositories && \
    apk add --no-cache --update nginx && \
    chown -R nginx:www-data /var/lib/nginx

COPY ./nginx.conf /etc/nginx/nginx.conf

EXPOSE 8080
WORKDIR /app
COPY package.json .
COPY vendor-wallet-toolbox.tgz .
COPY src/ src/
RUN npm i
COPY tsconfig.json .
RUN npm i knex typescript -g && \
    npm run build

# Run as non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

CMD [ "node", "out/src/index.js"]
