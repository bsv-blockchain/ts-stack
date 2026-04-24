/**
 * Checks if the provided service name is valid based on BRC-87 guidelines.
 * @param service - The service name to validate.
 * @returns True if the service name is valid, false otherwise.
 */
export const isValidTopicOrServiceName = (service: string): boolean => {
  const serviceRegex = /^(?=.{1,50}$)(?:tm_|ls_)[a-z]+(?:_[a-z]+)*$/
  return serviceRegex.test(service)
}
