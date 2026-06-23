/**
 * server.ts
 *
 * Entry point to start the server.
 */
import app from "./app";
import { migrateLatest } from "./db/knex";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { log } from "./logger";

const PORT = process.env.PORT || 8080;
const tracer = trace.getTracer("@bsv/wab-server");

async function startServer() {
    await tracer.startActiveSpan("wab.bootstrap", async (span) => {
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
            server.on('error', (err: Error) => {
                span.recordException(err);
                span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
                log.error({ operation: "listen", outcome: "error", err }, "Server failed to bind");
                span.end();
                process.exit(1);
            });
        } catch (err) {
            span.recordException(err as Error);
            span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
            log.error({ operation: "bootstrap", outcome: "error", err }, "Error starting server");
            span.end();
            process.exit(1);
        }
    });
}

startServer();
