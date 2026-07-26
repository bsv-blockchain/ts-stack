import swaggerJsdoc from 'swagger-jsdoc'
import swaggerUi from 'swagger-ui-express'
import { Express, type RequestHandler } from 'express'

export function setupSwagger(app: Express): void {
  const options = {
    definition: {
      openapi: '3.0.0',
      info: {
        title: 'MessageBox Server API',
        version: '1.0.0',
        description:
          'API documentation for the MessageBox Server, including message delivery, retrieval, acknowledgment, and overlay routing.'
      },
      servers: [
        {
          url: 'http://localhost:5001',
          description: 'Local Development Server'
        },
        {
          url: 'https://message-box-us-1.bsvb.tech',
          description: 'Production MessageBox Server'
        }
      ],
      components: {
        securitySchemes: {
          BsvMutualAuth: {
            type: 'apiKey',
            in: 'header',
            name: 'x-bsv-auth-identity-key',
            description:
              'BRC-103 mutual authentication over the BRC-104 HTTP binding. The complete x-bsv-auth-* header family is required.'
          }
        }
      },
      security: [
        {
          BsvMutualAuth: []
        }
      ]
    },
    apis: ['./src/routes/**/*.ts']
  }

  const swaggerSpec = swaggerJsdoc(options)

  // Casts bridge @types/swagger-ui-express v4 to Express v5's handler types.
  const swaggerHandlers = swaggerUi.serve as unknown as RequestHandler[]
  const swaggerSetup = swaggerUi.setup(swaggerSpec) as unknown as RequestHandler
  app.use('/docs', ...swaggerHandlers, swaggerSetup)

  // Serve raw OpenAPI spec at /openapi.json
  app.get('/openapi.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.send(swaggerSpec)
  })
}
