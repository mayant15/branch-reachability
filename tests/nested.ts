export function inspect(value: string | number) {
  if (typeof value === "number") {
    if (value === 1) {
      return "one"
    } else {
      return "another number"
    }
  } else {
    return value.toUpperCase()
  }
}
