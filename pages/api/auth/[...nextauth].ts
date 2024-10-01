import NextAuth, { AuthOptions } from 'next-auth'
import { jwtDecode } from 'jwt-decode'
import CredentialsProvider from 'next-auth/providers/credentials'
import axios from 'axios'

import { env } from '../../../env.mjs'
import { KeycloakJwtPayload } from '../../../server/types'

export const authOptions: AuthOptions = {
  session: { strategy: 'jwt' },
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      authorize: async (credentials) => {
        try {
          const { data } = await axios.post(
            `${env.KEYCLOAK_URL}/realms/${env.KEYCLOAK_REALM_NAME}/protocol/openid-connect/token`,
            new URLSearchParams({
              grant_type: 'password',
              client_id: env.KEYCLOAK_CLIENT_ID,
              client_secret: env.KEYCLOAK_CLIENT_SECRET,
              username: credentials?.email || '',
              password: credentials?.password || '',
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
          )

          const keycloakJwtPayload: KeycloakJwtPayload = jwtDecode(data.access_token)

          return {
            id: keycloakJwtPayload.sub,
            email: keycloakJwtPayload.email,
          }
        } catch (error) {
          console.log(error)
          const errorMessage = (error as any).response.data.error
          if (errorMessage === 'invalid_grant') {
            throw new Error('INVALID_CREDENTIALS')
          }
        }

        return null
      },
    }),
  ],
}

export default NextAuth(authOptions)
