function arraysOfObjectsAreEqual<T extends object>(
  arr1: readonly T[],
  arr2: readonly T[]
): boolean {
  if (arr1.length !== arr2.length) {
    return false
  }

  for (let i = 0; i < arr1.length; i++) {
    const obj1 = arr1[i]
    const obj2 = arr2[i]

    const keys1 = Object.keys(obj1) as Array<keyof T>
    const keys2 = Object.keys(obj2)

    if (keys1.length !== keys2.length) {
      return false
    }

    for (const key of keys1) {
      if (obj1[key] !== obj2[key]) {
        return false
      }
    }
  }

  return true
}
export default arraysOfObjectsAreEqual
