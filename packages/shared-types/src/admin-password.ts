import { z } from 'zod';

export const MIN_ADMIN_PASSWORD_LENGTH = 8;
export const MAX_ADMIN_PASSWORD_LENGTH = 128;

/**
 * A password is accepted verbatim, including leading and trailing spaces, so
 * whatever a password manager generated is what the administrator can type
 * back. Control characters are rejected because they cannot be retyped.
 */
export const adminPasswordSchema = z
  .string()
  .min(
    MIN_ADMIN_PASSWORD_LENGTH,
    `Must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters`,
  )
  .max(
    MAX_ADMIN_PASSWORD_LENGTH,
    `Must be at most ${MAX_ADMIN_PASSWORD_LENGTH} characters`,
  )
  .refine(
    (password) => !/\p{Cc}/u.test(password),
    'Must not contain control characters',
  );

export type AdminPassword = z.infer<typeof adminPasswordSchema>;

/**
 * A password being verified is only length-bounded. Applying the strength rules
 * here would let a rejected candidate reveal which rule it broke.
 */
const submittedPasswordSchema = z
  .string()
  .min(1)
  .max(MAX_ADMIN_PASSWORD_LENGTH);

/**
 * Public state the administration app reads before it renders: which sign-in
 * screen to show, and which controls the deployment actually accepts.
 */
export const adminAuthStatusSchema = z
  .object({
    /**
     * Whether an administration session may reach the ingestion-only upload
     * route. Published so the studio can hide a control the server refuses.
     * Defaulted, so a newer application reading an older server that does not
     * publish it yet hides the control rather than failing to open at all.
     */
    administrationUploadsEnabled: z.boolean().default(false),
    passwordConfigured: z.boolean(),
  })
  .strict();

export type AdminAuthStatus = z.infer<typeof adminAuthStatusSchema>;

/** The password is omitted while the installation has none configured. */
export const adminSessionRequestSchema = z
  .object({
    password: submittedPasswordSchema.optional(),
  })
  .strict();

export type AdminSessionRequest = z.infer<typeof adminSessionRequestSchema>;

/** `currentPassword` is required exactly when a password is configured. */
export const adminPasswordUpdateInputSchema = z
  .object({
    currentPassword: submittedPasswordSchema.optional(),
    newPassword: adminPasswordSchema,
  })
  .strict();

export type AdminPasswordUpdateInput = z.infer<
  typeof adminPasswordUpdateInputSchema
>;

export const adminPasswordRemovalInputSchema = z
  .object({
    currentPassword: submittedPasswordSchema,
  })
  .strict();

export type AdminPasswordRemovalInput = z.infer<
  typeof adminPasswordRemovalInputSchema
>;
