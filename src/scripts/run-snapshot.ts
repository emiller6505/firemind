import 'dotenv/config'
import { computeSnapshots } from '../workers/snapshot'

const formats = ['modern', 'standard'] as const

for (const format of formats) {
  await computeSnapshots(format)
}
