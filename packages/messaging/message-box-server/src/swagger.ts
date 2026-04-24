import swaggerJsdoc from 'swagger-jsdoc'
import swaggerUi from 'swagger-ui-express'
import { Express } from 'express'

export function setupSwagger (app: Express): void {
  const options = {
    definition: {
      openapi: '3.0.0',
      info: {
        title: 'MessageBox Server API',
        version: '1.0.0',
        description: 'API documentation for the MessageBox Server, including message delivery, retrieval, acknowledgment, and overlay routing.'
      },
      servers: [
        {
          url: 'http://localhost:5001',
          description: 'Local Development Server'
        },
        {
          url: 'https://messagebox.babbage.systems',
          description: 'Production MessageBox Server'
        }
      ],
      components: {
        securitySchemes: {
          BearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Provide your signed identity key JWT in the `Authorization` header as: `Bearer <token>`'
          }
        }
      },
      security: [
        {
          BearerAuth: []
        }
      ]
    },
    apis: ['./src/routes/*.ts']
  }

  const swaggerSpec = swaggerJsdoc(options)

  // Swagger UI at /docs
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec))

  // Serve raw OpenAPI spec at /openapi.json
  app.get('/openapi.json', (_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.send(swaggerSpec)
  })
}
