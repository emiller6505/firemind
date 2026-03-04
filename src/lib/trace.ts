const enabled = process.env.NODE_ENV !== 'test'

export interface Span {
  name: string
  start: number
  end?: number
  children: Span[]
}

export class Trace {
  readonly id: string
  private root: Span
  private stack: Span[]

  constructor(name: string) {
    this.id = Math.random().toString(36).slice(2, 8)
    this.root = { name, start: performance.now(), children: [] }
    this.stack = [this.root]
  }

  async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const span: Span = { name, start: performance.now(), children: [] }
    this.stack[this.stack.length - 1]!.children.push(span)
    this.stack.push(span)
    try {
      return await fn()
    } finally {
      span.end = performance.now()
      this.stack.pop()
    }
  }

  async timeAll<T extends readonly unknown[]>(
    entries: { [K in keyof T]: [string, () => Promise<T[K]>] },
  ): Promise<T> {
    const parent = this.stack[this.stack.length - 1]!
    const spans = entries.map(([name]) => {
      const span: Span = { name, start: performance.now(), children: [] }
      parent.children.push(span)
      return span
    })
    const results = await Promise.all(
      entries.map(([, fn], i) => {
        this.stack.push(spans[i]!)
        return fn().finally(() => {
          spans[i]!.end = performance.now()
        })
      }),
    )
    return results as unknown as T
  }

  finish() {
    this.root.end = performance.now()
    if (enabled) this.print()
  }

  private print() {
    const lines: string[] = []
    const walk = (span: Span, depth: number) => {
      const ms = span.end != null ? (span.end - span.start).toFixed(0) : '?'
      const indent = '  '.repeat(depth)
      lines.push(`${indent}${span.name} ${ms}ms`)
      for (const child of span.children) walk(child, depth + 1)
    }
    walk(this.root, 0)
    console.log(`[trace:${this.id}]\n${lines.join('\n')}`)
  }
}
