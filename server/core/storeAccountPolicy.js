'use strict';
function securityBlocked(profile = {}) {
  return profile.storeAccountStatus === 'suspended' || profile.storeSecurity?.state === 'blocked';
}
function registrationComplete(profile = {}) {
  const at = profile.storeRegistrationSecurity?.admittedAt;
  return profile.profileInitializationPending !== true && Number.isSafeInteger(at) && at > 0 && at <= Date.now() + 30000;
}
function requireEconomicAccount(profile = {}) {
  if (profile.storeSecurity?.state === 'blocked') throw Object.assign(new Error('SECURITY_ACCOUNT_BLOCKED'), { code: 'SECURITY_ACCOUNT_BLOCKED', statusCode: 403 });
  if (!registrationComplete(profile)) throw Object.assign(new Error('SECURITY_REGISTRATION_REQUIRED'), { code: 'SECURITY_REGISTRATION_REQUIRED', statusCode: 403 });
}
module.exports = { securityBlocked, registrationComplete, requireEconomicAccount };
