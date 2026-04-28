
Links: [API](#api), [Classes](#classes), [Types](#types)

# Classes

| |
| --- |
| [PaymailRoute](#class-paymailroute) |
| [PaymailRouter](#class-paymailrouter) |

Links: [API](#api), [Classes](#classes), [Types](#types)

---

## Class: PaymailRoute

```ts
export default class PaymailRoute {
    protected readonly domainLogicHandler: DomainLogicHandler;
    constructor(config: PaymailRouteConfig) 
    protected async defaultHandler(req: Request, res: Response, next: NextFunction): Promise<any> 
    protected async validateBody(body: any): Promise<void> 
    protected serializeResponse(response): string 
    protected sendSuccessResponse(res: Response, content: string): Response 
    public getHandler(): RequestHandler 
    public getCode(): string 
    public getEndpoint(): string 
    public getMethod(): "GET" | "POST" 
    static getNameAndDomain(params: any): {
        name: string;
        domain: string;
        pubkey?: string;
    } 
}
```

Links: [API](#api), [Classes](#classes), [Types](#types)

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

Links: [API](#api), [Classes](#classes), [Types](#types)

---
# Types

## Type: DomainLogicHandler

```ts
export type DomainLogicHandler = (params: any, body?: any, pubkey?: string) => Promise<any>
```

Links: [API](#api), [Classes](#classes), [Types](#types)

---
