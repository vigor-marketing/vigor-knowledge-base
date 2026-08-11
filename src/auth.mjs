import { createRemoteJWKSet, jwtVerify } from 'jose'

export function createAuthenticator({ issuer, audience, jwksUri }) {
  if (!issuer || !audience || !jwksUri) return undefined
  const keySet = createRemoteJWKSet(new URL(jwksUri))
  return async ({ authorization, cookie }) => {
    const cookieToken = cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('workbench_access_token='))?.slice('workbench_access_token='.length)
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : cookieToken
    if (!token) return undefined
    const { payload } = await jwtVerify(token, keySet, { issuer, audience })
    if (typeof payload.sub !== 'string' || !payload.sub.startsWith('usr_')) return undefined
    const roles = Array.isArray(payload.roles) ? payload.roles.filter(role => typeof role === 'string') : []
    return { personId: payload.sub, roles }
  }
}

export function canManageKnowledgeBase(actor) {
  return actor.roles.includes('general_manager') || actor.roles.includes('admin_specialist')
}
