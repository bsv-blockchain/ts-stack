/**
 * server.ts
 *
 * Entry point to start the server.
 */
import app from "./app";
import { migrateLatest } from "./db/knex";

const PORT = process.env.PORT || 8080;

async function startServer() {
    try {
        await migrateLatest();
        app.listen(PORT, () => {
            console.log(`WAB server running on http://localhost:${PORT}`);
        });
    } catch (err) {
        console.error("Error starting server:", err);
        process.exit(1);
    }
}

startServer();
