export type CompOffLotCandidate = {
  id: string;
  expiresOn: string;
  availableUnits: number;
};

export type CompOffUsage = {
  attendanceDate: string;
  units: number;
};

function roundUnits(value: number) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 10000) / 10000;
}

export function planCompOffFifoAllocations(
  candidates: CompOffLotCandidate[],
  usage: CompOffUsage[]
) {
  const lots = candidates.map((lot) => ({ ...lot, availableUnits: roundUnits(lot.availableUnits) }));
  const allocatedByLot = new Map<string, { lotId: string; units: number; expiresOn: string }>();

  for (const day of [...usage].sort((left, right) => left.attendanceDate.localeCompare(right.attendanceDate))) {
    let remaining = roundUnits(day.units);
    for (const lot of lots) {
      if (remaining <= 0) break;
      if (lot.expiresOn < day.attendanceDate || lot.availableUnits <= 0) continue;
      const units = Math.min(remaining, lot.availableUnits);
      lot.availableUnits = roundUnits(lot.availableUnits - units);
      remaining = roundUnits(remaining - units);
      const current = allocatedByLot.get(lot.id);
      allocatedByLot.set(lot.id, {
        lotId: lot.id,
        expiresOn: lot.expiresOn,
        units: roundUnits(Number(current?.units || 0) + units),
      });
    }
    if (remaining > 0) return null;
  }

  return Array.from(allocatedByLot.values());
}
