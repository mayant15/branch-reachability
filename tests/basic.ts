export function classify(value: number) {
  if (typeof value === "number") {
    return "number"
  } else {
    return "not a number"
  }
}
