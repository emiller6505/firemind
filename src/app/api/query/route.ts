import { NextRequest, NextResponse } from 'next/server'
import { handleQuery } from '@/query/index'

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null)
  if (!body?.query || typeof body.query !== 'string') {
    return NextResponse.json({ error: 'query string is required' }, { status: 400 })
  }
  if (body.query.length > 1000) {
    return NextResponse.json({ error: 'query too long (max 1000 chars)' }, { status: 400 })
  }

  try {
    const result = await handleQuery(body.query)
    return NextResponse.json(result)
  } catch (err) {
    console.error('[api/query]', err)
    return NextResponse.json({ error: 'Query failed' }, { status: 500 })
  }
}
