# MessageBox Server Deployment Guide
This guide covers how to deploy the MessageBox Server — a secure peer-to-peer message relay supporting authenticated HTTP and WebSocket communication and encrypted payloads.
________________________________________
### Overview
The MessageBox Server is a node-based Express server that enables identity-authenticated messaging over HTTP and WebSocket. Key features:
- Authenticated message sending and receiving
- Message box creation and routing by identity key
- WebSocket-based real-time delivery
- AES-encrypted message payloads (handled by clients)
________________________________________
### Requirements
- Node.js v18 or higher
- MySQL v8 or higher
- Docker (optional for local setup)
- A valid SERVER_PRIVATE_KEY - a 256-bit hex private key
- Wallet Storage instance URL (e.g., https://wallet-storage.babbage.systems)
________________________________________
### Project Structure
```bash
.
├── src/                    # Server source files (Express app, routes, WebSocket, logger)
├── knexfile.js             # DB connection settings
├── app.ts                  # Express and route setup
├── index.ts                # Server entry point with WebSocket support
├── .env                    # Environment variable configuration
└── ...
```
________________________________________
### Required Environment Variables

Create a .env file in the root with the following:

```env
NODE_ENV=production
SERVER_PRIVATE_KEY=your_hex_64_char_key
WALLET_STORAGE_URL=https://wallet-storage.babbage.systems
ENABLE_WEBSOCKETS=true
PORT=5001
ROUTING_PREFIX=
```

Optional:

```env
LOGGING_ENABLED=true
SKIP_NGINX=true     # Set to skip auto-starting nginx in production
```
________________________________________
### Deployment Steps
**Local Development**
1.	Install dependencies:
```bash
npm install
```
2.	Start MySQL database (you can use Docker or your local MySQL):
    - If using Docker:
    ```bash
    docker compose up --build
    ```
    - Otherwise, ensure a database is running and matches your knexfile.js.
3.	Set up environment variables:
```bash
cp .env.example .env
# Fill in actual values
```
4.	Run migrations:
```bash
npm run migrate
```
5.	Start the server in development mode:
```bash
npm run dev
```
Server will run at http://localhost:5001
________________________________________
### Production Deployment
1.	Ensure production .env is configured correctly
2.	Build the project (if applicable):
```bash
npm run build
```
3.	Run the server:
```bash
npm start
```
4.	Optionally, configure nginx to reverse proxy to the server. Nginx will start automatically unless SKIP_NGINX=true is set.
________________________________________
### WebSocket Support
WebSocket support is enabled by default unless ENABLE_WEBSOCKETS=false is set in .env.
Clients must authenticate with their identity key to establish a WebSocket connection.
________________________________________
### Testing
To run tests:
```bash
npm test
```
This includes unit tests and integration tests for HTTP and WebSocket message delivery.
________________________________________
### Docker Usage
Use Docker only if you're running a local test instance:
```bash
docker compose up -- build
```
- Web server runs on port 3002
- Database runs on port 3001
- PHPMyAdmin (for SQL browsing) runs on port 3003
________________________________________
### Deployment on Google Cloud Run
MessageBox can also be containerized and deployed on Google Cloud Run or any similar service. See DEPLOYING.md in backend/ for overlay-specific LARS deployment instructions.
________________________________________
### Related Projects
- [MessageBoxClient](https://github.com/bitcoin-sv/p2p)
- [WalletClient](https://github.com/bitcoin-sv)
- [Auth Middleware](https://www.npmjs.com/package/@bsv/auth-express-middleware)
________________________________________
📄 License
The MessageBox Server is licensed under the [Open BSV License](https://www.bsvlicense.org/).
________________________________________


