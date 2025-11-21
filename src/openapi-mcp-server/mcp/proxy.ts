import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, JSONRPCResponse, ListToolsRequestSchema, Tool } from '@modelcontextprotocol/sdk/types.js'
import { JSONSchema7 as IJsonSchema } from 'json-schema'
import { OpenAPIToMCPConverter } from '../openapi/parser'
import { HttpClient, HttpClientError } from '../client/http-client'
import { OpenAPIV3 } from 'openapi-types'
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

type PathItemObject = OpenAPIV3.PathItemObject & {
  get?: OpenAPIV3.OperationObject
  put?: OpenAPIV3.OperationObject
  post?: OpenAPIV3.OperationObject
  delete?: OpenAPIV3.OperationObject
  patch?: OpenAPIV3.OperationObject
}

type NewToolDefinition = {
  methods: Array<{
    name: string
    description: string
    inputSchema: IJsonSchema & { type: 'object' }
    returnSchema?: IJsonSchema
  }>
}

// import this class, extend and return server
export class MCPProxy {
  private server: Server
  private httpClient: HttpClient
  private openApiLookup: Record<string, OpenAPIV3.OperationObject & { method: string; path: string }>

  constructor(name: string, openApiSpec: OpenAPIV3.Document) {
    this.server = new Server({ name, version: '1.0.0' }, { capabilities: { tools: {} } })
    const baseUrl = openApiSpec.servers?.[0].url
    if (!baseUrl) {
      throw new Error('No base URL found in OpenAPI spec')
    }
    this.httpClient = new HttpClient(
      {
        baseUrl,
        headers: this.parseHeadersFromEnv(),
      },
      openApiSpec,
    )

    // Convert OpenAPI spec to MCP tools to get the lookup map
    // We won't use the generated tools directly, but we need the lookup to execute operations
    const converter = new OpenAPIToMCPConverter(openApiSpec)
    const { openApiLookup } = converter.convertToMCPTools()
    this.openApiLookup = openApiLookup

    // Check for required environment variable
    if (!process.env.NOTION_PAGE_ID) {
      console.warn('WARNING: NOTION_PAGE_ID environment variable is not set. read_page and append_block tools will fail.')
    }

    this.setupHandlers()
  }

  private setupHandlers() {
    // Handle tool listing
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: 'read_page',
            description: 'Read the title and blocks of the configured Notion page.',
            inputSchema: {
              type: 'object',
              properties: {},
            },
          },
          {
            name: 'append_block',
            description: 'Append a new text paragraph to the configured Notion page.',
            inputSchema: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'The text content of the new block' },
              },
              required: ['text'],
            },
          },
          {
            name: 'update_block',
            description: 'Update the text of an existing block.',
            inputSchema: {
              type: 'object',
              properties: {
                block_id: { type: 'string', description: 'The ID of the block to update' },
                text: { type: 'string', description: 'The new text content' },
              },
              required: ['block_id', 'text'],
            },
          },
          {
            name: 'delete_block',
            description: 'Delete (archive) a block.',
            inputSchema: {
              type: 'object',
              properties: {
                block_id: { type: 'string', description: 'The ID of the block to delete' },
              },
              required: ['block_id'],
            },
          },
        ],
      }
    })

    // Handle tool calling
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: params } = request.params

      try {
        switch (name) {
          case 'read_page':
            return await this.handleReadPage()
          case 'append_block':
            return await this.handleAppendBlock(params as { text: string; user_name?: string })
          case 'update_block':
            return await this.handleUpdateBlock(params as { block_id: string; text: string; user_name?: string })
          case 'delete_block':
            return await this.handleDeleteBlock(params as { block_id: string })
          default:
            throw new Error(`Unknown tool: ${name}`)
        }
      } catch (error) {
        console.error('Error in tool call', error)
        if (error instanceof HttpClientError) {
          const data = error.data?.response?.data ?? error.data ?? {}
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'error',
                  message: error.message,
                  details: data,
                }),
              },
            ],
          }
        }
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        }
      }
    })
  }

  private async handleReadPage() {
    const pageId = process.env.NOTION_PAGE_ID
    if (!pageId) throw new Error('NOTION_PAGE_ID is not set')

    // 1. Get Page Title
    const retrievePageOp = this.findOperation('API-retrieve-a-page')
    if (!retrievePageOp) throw new Error('Operation retrieve-a-page not found')

    const pageResponse = await this.httpClient.executeOperation(retrievePageOp, { page_id: pageId })
    const title = this.extractPageTitle(pageResponse.data)

    // 2. Get Block Children
    const getChildrenOp = this.findOperation('API-get-block-children')
    if (!getChildrenOp) throw new Error('Operation get-block-children not found')

    const childrenResponse = await this.httpClient.executeOperation(getChildrenOp, { block_id: pageId })
    const blocks = this.extractBlocks(childrenResponse.data)

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            title,
            blocks,
          }, null, 2),
        },
      ],
    }
  }

  private async handleAppendBlock(params: { text: string; user_name?: string }) {
    const pageId = process.env.NOTION_PAGE_ID
    if (!pageId) throw new Error('NOTION_PAGE_ID is not set')

    let textContent = params.text
    if (params.user_name) {
      const timeInIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
      textContent += `\n\nAction performed by ${params.user_name} at ${timeInIST}`
    }

    const patchChildrenOp = this.findOperation('API-patch-block-children')
    if (!patchChildrenOp) throw new Error('Operation patch-block-children not found')

    const response = await this.httpClient.executeOperation(patchChildrenOp, {
      block_id: pageId,
      children: [
        {
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [
              {
                type: 'text',
                text: {
                  content: textContent,
                },
              },
            ],
          },
        },
      ]
    })

    // Extract the ID of the new block (it's in results[0])
    const newBlockId = response.data.results?.[0]?.id

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ block_id: newBlockId }),
        },
      ],
    }
  }

  private async handleUpdateBlock(params: { block_id: string; text: string; user_name?: string }) {
    const updateBlockOp = this.findOperation('API-update-a-block')
    if (!updateBlockOp) throw new Error('Operation update-a-block not found')

    let textContent = params.text
    if (params.user_name) {
      const timeInIST = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
      textContent += `\n\nAction performed by ${params.user_name} at ${timeInIST}`
    }

    // 1. Fetch the block to get its type
    const retrieveBlockOp = this.findOperation('API-retrieve-a-block')
    if (!retrieveBlockOp) throw new Error('Operation retrieve-a-block not found')

    const blockResponse = await this.httpClient.executeOperation(retrieveBlockOp, { block_id: params.block_id })
    const blockType = blockResponse.data.type

    if (!blockResponse.data[blockType]?.rich_text) {
      throw new Error(`Block type '${blockType}' does not support text updates via this tool.`)
    }

    // 2. Update the block using the correct type property
    const updateBody = {
      [blockType]: {
        rich_text: [
          {
            type: 'text',
            text: {
              content: textContent,
            },
          },
        ],
      },
    }

    const response = await this.httpClient.executeOperation(updateBlockOp, { block_id: params.block_id, ...updateBody })

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response.data),
        },
      ],
    }
  }

  private async handleDeleteBlock(params: { block_id: string }) {
    const deleteBlockOp = this.findOperation('API-delete-a-block')
    if (!deleteBlockOp) throw new Error('Operation delete-a-block not found')

    const response = await this.httpClient.executeOperation(deleteBlockOp, { block_id: params.block_id })

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(response.data),
        },
      ],
    }
  }

  private findOperation(operationId: string): (OpenAPIV3.OperationObject & { method: string; path: string }) | null {
    return this.openApiLookup[operationId] ?? null
  }

  private parseHeadersFromEnv(): Record<string, string> {
    const notionToken = process.env.NOTION_TOKEN
    if (notionToken) {
      return {
        'Authorization': `Bearer ${notionToken}`,
        'Notion-Version': '2022-06-28'
      }
    }
    return {}
  }

  private extractPageTitle(pageData: any): string {
    // Notion page title is usually in properties.title.title[0].plain_text
    // But it depends on the property name (usually "title" or "Name")
    // We'll try to find a property of type "title"
    if (!pageData.properties) return 'Untitled'

    for (const prop of Object.values(pageData.properties) as any[]) {
      if (prop.type === 'title' && Array.isArray(prop.title)) {
        return prop.title.map((t: any) => t.plain_text).join('')
      }
    }
    return 'Untitled'
  }

  private extractBlocks(childrenData: any): any[] {
    if (!childrenData.results || !Array.isArray(childrenData.results)) return []

    return childrenData.results.map((block: any) => {
      let text = ''
      const type = block.type
      if (block[type]?.rich_text) {
        text = block[type].rich_text.map((t: any) => t.plain_text).join('')
      }

      return {
        id: block.id,
        type: block.type,
        text,
      }
    })
  }

  async connect(transport: Transport) {
    await this.server.connect(transport)
  }

  getServer() {
    return this.server
  }
}
