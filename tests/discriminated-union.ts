type Input =
  | {kind: "text"; value: string}
  | {kind: "count"; value: number}

export function render(input: Input) {
  if (input.kind === "text") {
    return input.value.toUpperCase()
  } else {
    return input.value.toFixed(0)
  }
}
