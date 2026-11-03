export function matchesOwnerEmail(accountEmail, configuredOwnerEmail) {
  const ownerEmail = typeof configuredOwnerEmail === 'string' ? configuredOwnerEmail.trim().toLowerCase() : ''
  const email = typeof accountEmail === 'string' ? accountEmail.trim().toLowerCase() : ''
  return Boolean(ownerEmail && email && email === ownerEmail)
}
