export function remainingColor(remaining: number): string {
  if (remaining >= 3) return 'text-ash'
  if (remaining === 2) return 'text-gold'
  return 'text-flame'
}

export function counterReady(isAnon: boolean, anonCount: number, remaining: number | null): boolean {
  return isAnon ? anonCount > 0 : remaining != null
}

export function showGoSpikeLink(displayRemaining: number): boolean {
  return displayRemaining <= 1
}
