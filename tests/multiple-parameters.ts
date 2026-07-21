export function compare(value: boolean, count: number) {
  if (typeof value === "string") {
    if (typeof count === "number") {
      return "string and number"
    } else {
      return "two strings"
    }
  } else {
    return "value is not a string"
  }
}
