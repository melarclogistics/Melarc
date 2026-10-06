/** A small but complete contract: one operation, a nullable property, an enumeration, and a defaulted request field. */
export const FIXTURE_CONTRACT = `openapi: 3.1.0
info:
  title: Fixture API
  version: 1.2.3-fixture
paths:
  /things:
    post:
      operationId: createThing
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/ThingCreate' }
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema: { $ref: '#/components/schemas/Thing' }
components:
  schemas:
    Thing:
      type: object
      required: [id]
      properties:
        id: { type: string }
        note: { type: string, nullable: true }
        label: { type: [string, 'null'] }
        status: { type: string, enum: [OPEN, CLOSED] }
    ThingCreate:
      type: object
      required: [name]
      properties:
        name: { type: string }
        flag: { type: boolean, default: false }
`;
