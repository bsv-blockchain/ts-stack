# API

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

## Interfaces

| |
| --- |
| [EngineConfig](#interface-engineconfig) |
| [JanitorConfig](#interface-janitorconfig) |
| [UIConfig](#interface-uiconfig) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---

### Interface: EngineConfig

Configuration options that map to Engine constructor parameters.

```ts
export interface EngineConfig {
    chainTracker?: ChainTracker | "scripts only";
    shipTrackers?: string[];
    slapTrackers?: string[];
    broadcaster?: Broadcaster;
    advertiser?: Advertiser;
    syncConfiguration?: Record<string, string[] | "SHIP" | false>;
    logTime?: boolean;
    logPrefix?: string;
    throwOnBroadcastFailure?: boolean;
    overlayBroadcastFacilitator?: OverlayBroadcastFacilitator;
    suppressDefaultSyncAdvertisements?: boolean;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---
### Interface: JanitorConfig

Configuration for the Janitor Service

```ts
export interface JanitorConfig {
    mongoDb: Db;
    logger?: typeof console;
    requestTimeoutMs?: number;
    hostDownRevokeScore?: number;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---
### Interface: UIConfig

```ts
export interface UIConfig {
    host?: string;
    faviconUrl?: string;
    backgroundColor?: string;
    primaryColor?: string;
    secondaryColor?: string;
    fontFamily?: string;
    headingFontFamily?: string;
    additionalStyles?: string;
    sectionBackgroundColor?: string;
    primaryTextColor?: string;
    linkColor?: string;
    hoverColor?: string;
    borderColor?: string;
    secondaryBackgroundColor?: string;
    secondaryTextColor?: string;
    defaultContent?: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---
## Classes

| |
| --- |
| [JanitorService](#class-janitorservice) |
| [OverlayExpress](#class-overlayexpress) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---

### Class: JanitorService

JanitorService runs a single pass of health checks on SHIP and SLAP outputs.
It validates domain names and checks /health endpoints to ensure services are operational.

When a service is down, it increments a "down" counter. When healthy, it decrements.
If the down counter reaches HOST_DOWN_REVOKE_SCORE, it deletes the output from the database.

This service is designed to be run periodically via external schedulers (e.g., cron, docker-compose).

```ts
export class JanitorService {
    constructor(config: JanitorConfig) 
    async run(): Promise<void> 
}
```

See also: [JanitorConfig](#interface-janitorconfig)

<details>

<summary>Class JanitorService Details</summary>

#### Method run

Runs a single pass of health checks on all SHIP and SLAP outputs

```ts
async run(): Promise<void> 
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---
### Class: OverlayExpress

OverlayExpress class provides an Express-based server for hosting Overlay Services.
It allows configuration of various components like databases, topic managers, and lookup services.
It encapsulates an Express application and provides methods to start the server.

```ts
export default class OverlayExpress {
    app: express.Application;
    port: number = 3000;
    logger: typeof console = console;
    knex: Knex.Knex = {} as unknown as Knex.Knex;
    migrationsToRun: Migration[] = [];
    mongoDb: Db = {} as unknown as Db;
    network: "main" | "test" = "main";
    chainTracker: ChainTracker | "scripts only" = new WhatsOnChain(this.network);
    engine: Engine = {} as unknown as Engine;
    managers: Record<string, TopicManager> = {};
    services: Record<string, LookupService> = {};
    enableGASPSync: boolean = true;
    arcApiKey: string | undefined = undefined;
    verboseRequestLogging: boolean = false;
    webUIConfig: UIConfig = {};
    engineConfig: EngineConfig = {};
    janitorConfig: {
        requestTimeoutMs: number;
        hostDownRevokeScore: number;
    } = {
        requestTimeoutMs: 10000,
        hostDownRevokeScore: 3
    };
    constructor(public name: string, public privateKey: string, public advertisableFQDN: string, adminToken?: string) 
    getAdminToken(): string 
    configurePort(port: number): void 
    configureWebUI(config: UIConfig): void 
    configureJanitor(config: Partial<typeof this.janitorConfig>): void 
    configureLogger(logger: typeof console): void 
    configureNetwork(network: "main" | "test"): void 
    configureChainTracker(chainTracker: ChainTracker | "scripts only" = new WhatsOnChain(this.network)): void 
    configureArcApiKey(apiKey: string): void 
    configureEnableGASPSync(enable: boolean): void 
    configureVerboseRequestLogging(enable: boolean): void 
    async configureKnex(config: Knex.Knex.Config | string): Promise<void> 
    async configureMongo(connectionString: string): Promise<void> 
    configureTopicManager(name: string, manager: TopicManager): void 
    configureLookupService(name: string, service: LookupService): void 
    configureLookupServiceWithKnex(name: string, serviceFactory: (knex: Knex.Knex) => {
        service: LookupService;
        migrations: Migration[];
    }): void 
    configureLookupServiceWithMongo(name: string, serviceFactory: (mongoDb: Db) => LookupService): void 
    configureEngineParams(params: EngineConfig): void 
    async configureEngine(autoConfigureShipSlap = true): Promise<void> 
    async start(): Promise<void> 
}
```

See also: [EngineConfig](#interface-engineconfig), [UIConfig](#interface-uiconfig)

<details>

<summary>Class OverlayExpress Details</summary>

#### Constructor

Constructs an instance of OverlayExpress.

```ts
constructor(public name: string, public privateKey: string, public advertisableFQDN: string, adminToken?: string) 
```

Argument Details

+ **name**
  + The name of the service
+ **privateKey**
  + Private key used for signing advertisements
+ **advertisableFQDN**
  + The fully qualified domain name where this service is available. Does not include "https://".
+ **adminToken**
  + Optional. An administrative Bearer token used to protect admin routes.
  If not provided, a random token will be generated at runtime.

#### Method configureArcApiKey

Configures the ARC API key.

```ts
configureArcApiKey(apiKey: string): void 
```

Argument Details

+ **apiKey**
  + The ARC API key

#### Method configureChainTracker

Configures the ChainTracker to be used.
If 'scripts only' is used, it implies no full SPV chain tracking in the Engine.

```ts
configureChainTracker(chainTracker: ChainTracker | "scripts only" = new WhatsOnChain(this.network)): void 
```

Argument Details

+ **chainTracker**
  + An instance of ChainTracker or 'scripts only'

#### Method configureEnableGASPSync

Enables or disables GASP synchronization (high-level setting).
This is a broad toggle that can be overridden or customized through syncConfiguration.

```ts
configureEnableGASPSync(enable: boolean): void 
```

Argument Details

+ **enable**
  + true to enable, false to disable

#### Method configureEngine

Configures the Overlay Engine itself.
By default, auto-configures SHIP and SLAP unless autoConfigureShipSlap = false
Then it merges in any advanced engine config from `this.engineConfig`.

```ts
async configureEngine(autoConfigureShipSlap = true): Promise<void> 
```

Argument Details

+ **autoConfigureShipSlap**
  + Whether to auto-configure SHIP and SLAP services (default: true)

#### Method configureEngineParams

Advanced configuration method for setting or overriding any
Engine constructor parameters via an EngineConfig object.

Example usage:
  configureEngineParams({
    logTime: true,
    throwOnBroadcastFailure: true,
    overlayBroadcastFacilitator: new MyCustomFacilitator()
  })

These fields will be respected when we finally build/configure the Engine
in the `configureEngine()` method below.

```ts
configureEngineParams(params: EngineConfig): void 
```
See also: [EngineConfig](#interface-engineconfig)

#### Method configureJanitor

Configures the janitor service parameters

```ts
configureJanitor(config: Partial<typeof this.janitorConfig>): void 
```

Argument Details

+ **config**
  + Janitor configuration options
- requestTimeoutMs: Timeout for health check requests (default: 10000ms)
- hostDownRevokeScore: Number of consecutive failures before deleting output (default: 3)

#### Method configureKnex

Configure Knex (SQL) database connection.

```ts
async configureKnex(config: Knex.Knex.Config | string): Promise<void> 
```

Argument Details

+ **config**
  + Knex configuration object, or MySQL connection string (e.g. mysql://overlayAdmin:overlay123@mysql:3306/overlay).

#### Method configureLogger

Configures the logger to be used by the server.

```ts
configureLogger(logger: typeof console): void 
```

Argument Details

+ **logger**
  + A logger object (e.g., console)

#### Method configureLookupService

Configures a Lookup Service.

```ts
configureLookupService(name: string, service: LookupService): void 
```

Argument Details

+ **name**
  + The name of the Lookup Service
+ **service**
  + An instance of LookupService

#### Method configureLookupServiceWithKnex

Configures a Lookup Service using Knex (SQL) database.

```ts
configureLookupServiceWithKnex(name: string, serviceFactory: (knex: Knex.Knex) => {
    service: LookupService;
    migrations: Migration[];
}): void 
```

Argument Details

+ **name**
  + The name of the Lookup Service
+ **serviceFactory**
  + A factory function that creates a LookupService instance using Knex

#### Method configureLookupServiceWithMongo

Configures a Lookup Service using MongoDB.

```ts
configureLookupServiceWithMongo(name: string, serviceFactory: (mongoDb: Db) => LookupService): void 
```

Argument Details

+ **name**
  + The name of the Lookup Service
+ **serviceFactory**
  + A factory function that creates a LookupService instance using MongoDB

#### Method configureMongo

Configures the MongoDB database connection.

```ts
async configureMongo(connectionString: string): Promise<void> 
```

Argument Details

+ **connectionString**
  + MongoDB connection string

#### Method configureNetwork

Configures the BSV Blockchain network to be used ('main' or 'test').
By default, it re-initializes chainTracker as a WhatsOnChain for that network.

```ts
configureNetwork(network: "main" | "test"): void 
```

Argument Details

+ **network**
  + The network ('main' or 'test')

#### Method configurePort

Configures the port on which the server will listen.

```ts
configurePort(port: number): void 
```

Argument Details

+ **port**
  + The port number

#### Method configureTopicManager

Configures a Topic Manager.

```ts
configureTopicManager(name: string, manager: TopicManager): void 
```

Argument Details

+ **name**
  + The name of the Topic Manager
+ **manager**
  + An instance of TopicManager

#### Method configureVerboseRequestLogging

Enables or disables verbose request logging.

```ts
configureVerboseRequestLogging(enable: boolean): void 
```

Argument Details

+ **enable**
  + true to enable, false to disable

#### Method configureWebUI

Configures the web user interface

```ts
configureWebUI(config: UIConfig): void 
```
See also: [UIConfig](#interface-uiconfig)

Argument Details

+ **config**
  + Web UI configuration options

#### Method getAdminToken

Returns the current admin token in case you need to programmatically retrieve or display it.

```ts
getAdminToken(): string 
```

#### Method start

Starts the Express server.
Sets up routes and begins listening on the configured port.

```ts
async start(): Promise<void> 
```

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes)

---
