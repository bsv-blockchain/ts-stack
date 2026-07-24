# Telemetry

The SDK exposes a small, vendor-neutral telemetry interface for operational
events. It is disabled by default and does not select a monitoring provider.
A consumer can adapt it to OpenTelemetry, Sentry, a crash reporter, or an
internal support-event pipeline.

```ts
import { LookupResolver, TelemetryConfig, TelemetryEvent } from '@bsv/sdk'

const telemetry: TelemetryConfig = {
  minimumSeverity: 'info',
  sink: {
    capture(event: Readonly<TelemetryEvent>) {
      supportEvents.enqueue(event)
    }
  },
  correlationIdFactory: () => tracing.currentCorrelationId(),
  beforeSend: event => ({
    ...event,
    attributes: {
      ...event.attributes,
      applicationVersion: '4.7.0',
      platform: 'linux'
    }
  })
}

const resolver = new LookupResolver({ telemetry })
```

`capture` never throws into SDK behavior. Synchronous and asynchronous sink
failures are isolated. Events are sanitized before `beforeSend` and sanitized
again afterward, so consumer enrichment cannot bypass the redaction boundary.

The event schema intentionally permits scalar attributes only. Names and values
associated with passwords, private or presentation keys, recovery material,
tokens, OTPs, Shamir shares, ciphertext, and snapshots are redacted. Common key
encodings and large encoded blobs are also removed from diagnostic text. Error
stacks are disabled by default and should be enabled only for a trusted sink.

Redaction is a defense in depth measure, not permission to attach sensitive
objects. Producers and consumers must never add request payloads, keys, wallet
snapshots, encrypted factors, or transaction material to telemetry.

`LookupResolver.queryDetailed()` returns the ordinary lookup answer together
with host-settlement evidence. Security-sensitive code can use the counts to
distinguish an authoritative empty result from timeouts, malformed responses,
semantic rejection, or partial availability.
