export function restParameter(value: string, ...rest: string[]) {
  if (typeof value === "string") {
    return rest.length
  }
}

export function defaultParameter(value: string = "fallback") {
  if (typeof value === "string") {
    return value
  }
}

export function destructuredParameter({value}: {value: string}) {
  if (typeof value === "string") {
    return value
  }
}

export function explicitThis(this: {ready: boolean}, value: string) {
  if (typeof value === "string") {
    return this.ready
  }
}

export function declarationScope(value: string) {
  if (value) function helper() {}
  helper()
}
