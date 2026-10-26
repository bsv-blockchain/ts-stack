export const CHIRP_OPENAPI_DOCUMENT = {
  openapi: '3.1.0',
  info: {
    title: 'BRC-167 CHIRP Complete Host API',
    version: '1.0.0',
    description: 'Baseline upload-session and complete-host retrieval profile for CHIRP v1.'
  },
  components: {
    securitySchemes: {
      bsvAuth: {
        type: 'http',
        scheme: 'bsv-auth',
        description: 'BRC-103/104 mutually authenticated request transport.'
      }
    }
  },
  paths: {
    '/chirp/v1/uploads': {
      post: {
        summary: 'Create an authenticated CHIRP staging session',
        security: [{ bsvAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['retentionSeconds', 'logicalLength'],
                properties: {
                  retentionSeconds: {
                    type: 'string',
                    pattern: '^[1-9][0-9]{0,19}$',
                    maxLength: 20
                  },
                  logicalLength: {
                    oneOf: [
                      {
                        type: 'string',
                        pattern: '^(0|[1-9][0-9]{0,19})$',
                        maxLength: 20
                      },
                      { type: 'null' }
                    ]
                  }
                }
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Staging session created',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['uploadId', 'stagingExpiresAt'],
                  properties: {
                    uploadId: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 512,
                      pattern: '^[^\\u0000-\\u001F\\u007F]+$'
                    },
                    stagingExpiresAt: {
                      type: 'string',
                      pattern: '^[1-9][0-9]{0,19}$',
                      maxLength: 20
                    }
                  }
                }
              }
            }
          },
          '400': { description: 'Invalid session request' }
        }
      }
    },
    '/chirp/v1/uploads/{uploadId}/objects/{objectIdentifier}': {
      parameters: [
        {
          name: 'uploadId',
          in: 'path',
          required: true,
          schema: { type: 'string', minLength: 1, maxLength: 512 }
        },
        {
          name: 'objectIdentifier',
          in: 'path',
          required: true,
          schema: { type: 'string', pattern: '^[1-9A-HJ-NP-Za-km-z]{52}$' }
        }
      ],
      head: {
        summary: 'Check whether an authenticated session already references an object',
        security: [{ bsvAuth: [] }],
        responses: {
          '200': { description: 'Object is staged' },
          '404': { description: 'Not staged' }
        }
      },
      put: {
        summary: 'Stream-hash and stage an immutable CHIRP object',
        security: [{ bsvAuth: [] }],
        requestBody: {
          required: true,
          content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } }
        },
        responses: {
          '201': { description: 'Object newly staged' },
          '204': { description: 'Identical object already referenced' },
          '400': { description: 'Identifier or digest mismatch' },
          '413': { description: 'Object exceeds the v1 limit' }
        }
      }
    },
    '/chirp/v1/uploads/{uploadId}/commit': {
      post: {
        summary:
          'Validate a complete closure, establish its lease, and advertise its root through UHRP',
        security: [{ bsvAuth: [] }],
        parameters: [
          {
            name: 'uploadId',
            in: 'path',
            required: true,
            schema: { type: 'string', minLength: 1, maxLength: 512 }
          }
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['rootIdentifier'],
                properties: {
                  rootIdentifier: {
                    type: 'string',
                    pattern: '^[1-9A-HJ-NP-Za-km-z]{52}$'
                  }
                }
              }
            }
          }
        },
        responses: {
          '201': {
            description: 'Complete host commitment published',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['chirpURL', 'uhrpURL', 'hostedFileLocation', 'expiryTime'],
                  properties: {
                    chirpURL: { type: 'string', pattern: '^chirp://[1-9A-HJ-NP-Za-km-z]{52}$' },
                    uhrpURL: { type: 'string', pattern: '^uhrp://[1-9A-HJ-NP-Za-km-z]{52}$' },
                    hostedFileLocation: { type: 'string', format: 'uri' },
                    expiryTime: { type: 'integer', minimum: 1 }
                  }
                }
              }
            }
          },
          '400': { description: 'Invalid or incomplete closure' },
          '404': { description: 'Unknown or expired staging session' }
        }
      }
    },
    '/chirp/v1/{rootIdentifier}/objects/{objectIdentifier}': {
      parameters: [
        {
          name: 'rootIdentifier',
          in: 'path',
          required: true,
          schema: { type: 'string', pattern: '^[1-9A-HJ-NP-Za-km-z]{52}$' }
        },
        {
          name: 'objectIdentifier',
          in: 'path',
          required: true,
          schema: { type: 'string', pattern: '^[1-9A-HJ-NP-Za-km-z]{52}$' }
        }
      ],
      get: {
        summary: 'Retrieve an exact object from an unexpired complete-host closure',
        responses: {
          '200': { description: 'Exact immutable object bytes' },
          '404': { description: 'Root is unavailable or object is outside its closure' }
        }
      },
      head: {
        summary: 'Inspect an object in an unexpired complete-host closure',
        responses: {
          '200': { description: 'Object metadata' },
          '404': { description: 'Not available' }
        }
      }
    }
  }
} as const
