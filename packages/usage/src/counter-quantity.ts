/** A counter's quantity after adding `delta`; integer counters must stay safe integers. */
export function addCounterQuantity(previous: number, delta: number, metric: string) {
  const quantity = previous + delta;
  if (
    !Number.isFinite(quantity) ||
    (Number.isInteger(previous) && Number.isInteger(delta) && !Number.isSafeInteger(quantity))
  ) {
    throw new Error(`Usage counter ${metric} exceeds the safe numeric range.`);
  }
  return quantity;
}
