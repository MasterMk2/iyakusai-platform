// Public surface of the login core (wired by the account composition in src/server/account/).
export * from './types.js';
export {
  LoginService,
  normalizeEmail,
  validatePolicy,
  type AuthenticatedSession,
  type ChallengeOutcome,
  type LoginServiceOptions,
  type PasswordSetupOutcome,
  type ResendOutcome,
  type SetupVerifyOutcome,
  type VerifyOutcome,
} from './service.js';
export { MemoryLoginStore } from './memory-store.js';
export {
  checkPasswordPolicy,
  LOW_COST_TEST_ONLY,
  PASSWORD_POLICY,
  PasswordHasher,
  SCRYPT_MAXMEM,
  SCRYPT_PRODUCTION,
  SCRYPT_TEST_ONLY,
  type PasswordHash,
} from './password.js';
export { FileLoginPersistence, fileAuditSink, LoginStoreIntegrityError, memoryAuditSink } from './file-store.js';
