import { z } from 'zod'
import { jwtDecode } from 'jwt-decode'
import { TRPCError } from '@trpc/server'
import axios from 'axios'
import jwt from 'jsonwebtoken'

import { protectedProcedure, router } from '../trpc'
import { env } from '../../env.mjs'
import { KeycloakJwtPayload, UserSettingsJwtPayload } from '../types'
import { keycloak, transporter } from '../services'
import { authenticateKeycloakClient } from '../utils/keycloak'
import { fundSlugs } from '../../utils/funds'

export const accountRouter = router({
  changePassword: protectedProcedure
    .input(z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.session.user.sub
      const email = ctx.session.user.email
      let accessToken = ''

      try {
        const { data: token } = await axios.post(
          `${env.KEYCLOAK_URL}/realms/${env.KEYCLOAK_REALM_NAME}/protocol/openid-connect/token`,
          new URLSearchParams({
            grant_type: 'password',
            client_id: env.KEYCLOAK_CLIENT_ID,
            client_secret: env.KEYCLOAK_CLIENT_SECRET,
            username: ctx.session.user.email,
            password: input.currentPassword,
          }),
          { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
        )

        accessToken = token.access_token
      } catch (error) {
        const errorMessage = (error as any).response.data.error

        if (errorMessage === 'invalid_grant') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'INVALID_PASSWORD' })
        }

        throw error
      }

      const keycloakJwtPayload: KeycloakJwtPayload = jwtDecode(accessToken)

      if (keycloakJwtPayload.sub !== userId || keycloakJwtPayload.email !== email) {
        throw new TRPCError({ code: 'FORBIDDEN' })
      }

      await authenticateKeycloakClient()

      await keycloak.users.update(
        { id: userId },
        {
          email,
          credentials: [{ type: 'password', value: input.newPassword, temporary: false }],
        }
      )
    }),

  requestEmailChange: protectedProcedure
    .input(z.object({ fundSlug: z.enum(fundSlugs), newEmail: z.string().email() }))
    .mutation(async ({ input, ctx }) => {
      const userId = ctx.session.user.sub
      const email = ctx.session.user.email

      await authenticateKeycloakClient()
      const usersAlreadyUsingEmail = await keycloak.users.find({ email: input.newEmail })

      if (usersAlreadyUsingEmail.length) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'EMAIL_TAKEN' })
      }

      const user = await keycloak.users.findOne({ id: userId })

      if (!user || !user.id || !user.email)
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'USER_NOT_FOUND',
        })

      let emailVerifyTokenVersion = parseInt(user.attributes?.emailVerifyTokenVersion?.[0]) || null

      if (!emailVerifyTokenVersion) {
        await keycloak.users.update(
          { id: userId },
          { email: user.email, attributes: { emailVerifyTokenVersion: 1 } }
        )
        emailVerifyTokenVersion = 1
      }

      const payload: UserSettingsJwtPayload = {
        action: 'email_verify',
        userId: user.id,
        email: input.newEmail,
        tokenVersion: emailVerifyTokenVersion,
      }

      const token = jwt.sign(payload, env.USER_SETTINGS_JWT_SECRET, { expiresIn: '30m' })

      // no await here as we don't want to block the response
      transporter.sendMail({
        from: env.SES_VERIFIED_SENDER,
        to: input.newEmail,
        subject: 'Verify your email',
        html: `<a href="${env.APP_URL}/${input.fundSlug}/verify-email/${token}" target="_blank">Verify email</a>`,
      })
    }),
})
