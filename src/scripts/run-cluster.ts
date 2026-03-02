import 'dotenv/config'
import { clusterArchetypes } from '../workers/cluster'

const formats = ['modern', 'standard'] as const

for (const format of formats) {
  await clusterArchetypes(format)
}
