
Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

# Interfaces

## Interface: PaymailRouteParams

```ts
export interface PaymailRouteParams {
    [key: string]: string;
    paymail: string;
}
```

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---
# Classes

| |
| --- |
| [PaymailRoute](#class-paymailroute) |
| [PaymailRouter](#class-paymailrouter) |

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---

## Class: PaymailRoute

```ts
export default class PaymailRoute {
    protected readonly domainLogicHandler: DomainLogicHandler;
    constructor(config: PaymailRouteConfig)
    protected async defaultHandler(req: Request, res: Response, next: NextFunction): Promise<void>
    protected async validateBody(body: unknown): Promise<unknown>
    protected validateParams(params: PaymailRouteParams): PaymailRouteParams
    protected snapshotValidatedBody(body: unknown): unknown
    protected snapshotValidatedParams(params: PaymailRouteParams): PaymailRouteParams
    protected serializeResponse(response: unknown, _validatedBody?: unknown, _validatedParams?: PaymailRouteParams): string
    protected sendSuccessResponse(res: Response, content: string): Response
    public getHandler(): RequestHandler
    public getCode(): string
    public getEndpoint(): string
    public getMethod(): "GET" | "POST"
    public getSenderValidationMode(): "not-applicable" | "required" | "disabled"
    static getNameAndDomain(params: PaymailRouteParams): {
        name: string;
        domain: string;
        pubkey?: string;
    }
}
```

See also: [DomainLogicHandler](#type-domainlogichandler), [PaymailRouteParams](#interface-paymailrouteparams)

<details>

<summary>Class PaymailRoute Details</summary>

### Method snapshotValidatedBody

Captures response-validation evidence before domain logic can mutate its input.

```ts
protected snapshotValidatedBody(body: unknown): unknown
```

### Method snapshotValidatedParams

Captures route identity evidence before domain logic can mutate its input.

```ts
protected snapshotValidatedParams(params: PaymailRouteParams): PaymailRouteParams
```
See also: [PaymailRouteParams](#interface-paymailrouteparams)

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---
## Class: PaymailRouter

PaymailRouter is responsible for routing and handling Paymail requests.
It sets up the necessary routes and handlers based on the given configuration.

```ts
export default class PaymailRouter {
    public baseUrl: string;
    public basePath: string;
    public routes: PaymailRoute[];
    public requestSenderValidation: boolean;
    constructor(config: PaymailRouterConfig)
    public getRouter(): Router
}
```

See also: [PaymailRoute](#class-paymailroute)

<details>

<summary>Class PaymailRouter Details</summary>

### Constructor

Creates an instance of PaymailRouter.

```ts
constructor(config: PaymailRouterConfig)
```

Argument Details

+ **config**
  + Configuration options for the PaymailRouter.

### Method getRouter

Gets the configured express Router.

```ts
public getRouter(): Router
```

Returns

The express Router with all configured routes and handlers.

</details>

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---
# Functions

# Types

## Type: DomainLogicHandler

```ts
export type DomainLogicHandler = (params: PaymailRouteParams, body?: unknown, pubkey?: string) => unknown
```

See also: [PaymailRouteParams](#interface-paymailrouteparams)

Links: [API](#api), [Interfaces](#interfaces), [Classes](#classes), [Functions](#functions), [Types](#types)

---
