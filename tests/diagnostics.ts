export function assignNumber(value: number) {
  value = 123

  if (typeof value === "string") {
    return value.toUpperCase()
  } else {
    return "not a string"
  }
}
