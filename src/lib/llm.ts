import Anthropic from '@anthropic-ai/sdk'

export interface LLMOptions {
  maxTokens?: number
  temperature?: number
}

export interface LLMProvider {
  complete(system: string, user: string, opts?: LLMOptions): Promise<string>
}

class ClaudeProvider implements LLMProvider {
  private client: Anthropic

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error('Missing ANTHROPIC_API_KEY env var')
    this.client = new Anthropic({ apiKey })
  }

  async complete(system: string, user: string, opts: LLMOptions = {}): Promise<string> {
    const msg = await this.client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: opts.maxTokens ?? 1024,
      temperature: opts.temperature ?? 1,
      system,
      messages: [{ role: 'user', content: user }],
    })
    const block = msg.content[0]
    if (!block || block.type !== 'text') throw new Error('Unexpected response type from Claude')
    return block.text
  }
}

export const llm: LLMProvider = new ClaudeProvider()
