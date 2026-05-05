# Use an official Node.js runtime as the base image
FROM node:22-alpine

# Set working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json .
COPY tsconfig.json .

# Install dependencies
RUN npm install

# Copy application source code into the container
COPY src ./src

# Expose the application port
EXPOSE 8080

RUN npm run build

RUN chown -R node:node /app

USER node

# Start the application
CMD ["npm", "start"]
