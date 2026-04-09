# Use an official Node.js runtime as the base image
FROM node:22-alpine

# Set working directory inside the container
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json .

# Install dependencies
RUN npm install

# Copy the entire application code into the container
COPY . .

# Expose the application port
EXPOSE 8080

RUN npm run build

# Start the application
CMD ["npm", "start"]
