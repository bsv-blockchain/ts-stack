/**
 * server.ts
 *
 * Entry point to start the server.
 */
import app from "./app";
import { db, migrateLatest } from "./db/knex";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { log } from "./logger";
import { configureHttpServer } from "./security/edgePolicy";
import type { Server } from "node:http";

const PORT = process.env.PORT || 8080;
const tracer = trace.getTracer("@bsv/wab-server");

async function startServer(): Promise<Server | undefined> {
    return await tracer.startActiveSpan("wab.bootstrap", async (span) => {
        const startedAt = Date.now();
        try {
            await migrateLatest();
            log.info({ operation: "migrate", outcome: "ok" }, "migrations applied");
            const server = app.listen(PORT, () => {
                span.setStatus({ code: SpanStatusCode.OK });
                log.info(
                    { operation: "listen", outcome: "ok", port: PORT, duration_ms: Date.now() - startedAt },
                    "WAB server running"
                );
                span.end();
            });
            configureHttpServer(server, 'WAB', {
                requestTimeoutMs: 30_000,
                headersTimeoutMs: 10_000,
                keepAliveTimeoutMs: 5_000,
                socketTimeoutMs: 30_000,
                maxRequestsPerSocket: 1_000
            });
            server.on('error', (err: Error) => {
                span.recordException(err);
                span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
                log.error({ operation: "listen", outcome: "error", err }, "Server failed to bind");
                span.end();
                process.exit(1);
            });
            return server;
        } catch (err) {
            span.recordException(err as Error);
            span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
            log.error({ operation: "bootstrap", outcome: "error", err }, "Error starting server");
            span.end();
            process.exit(1);
        }
    });
}

let shutdownPromise: Promise<void> | undefined;

function shutdown(server: Server, signal: NodeJS.Signals): Promise<void> {
    shutdownPromise ??= (async () => {
        log.info({ operation: "shutdown", signal }, "WAB shutdown started");
        await new Promise<void>((resolve, reject) => {
            server.close(error => error == null ? resolve() : reject(error));
        });
        await db.destroy();
        log.info({ operation: "shutdown", outcome: "ok", signal }, "WAB shutdown complete");
    })().catch(error => {
        process.exitCode = 1;
        log.error(
            { operation: "shutdown", outcome: "error", signal, err: error },
            "WAB shutdown failed"
        );
    });
    return shutdownPromise;
}

void startServer().then(server => {
    if (server === undefined) return;
    process.once("SIGTERM", () => void shutdown(server, "SIGTERM"));
    process.once("SIGINT", () => void shutdown(server, "SIGINT"));
});
