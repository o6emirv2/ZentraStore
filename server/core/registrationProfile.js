"use strict";
const {
  validatePersonName,
  validateBirthDate,
} = require("./storeProfileService");
const {
  validateUsername,
  usernameKeys,
  usernameRegistryId,
  findUsernameProfiles,
} = require("./storeUsername");
const { readStoredBalance } = require("./storeMoney");
const fail = (code, statusCode = 400) =>
  Object.assign(new Error(code), { code, statusCode });
function normalizeProfile(input) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) =>
        !["firstName", "lastName", "username", "birthDate"].includes(key),
    )
  )
    throw fail("REGISTRATION_PROFILE_INVALID");
  return {
    firstName: validatePersonName(input.firstName, "İsim"),
    lastName: validatePersonName(input.lastName, "Soyisim"),
    username: validateUsername(input.username),
    birthDate: validateBirthDate(input.birthDate),
  };
}
async function writeInitialProfile(
  tx,
  db,
  identity,
  input,
  { verificationRequired = false } = {},
) {
  const { uid, email } = identity;
  const profile = normalizeProfile(input);
  const keys = usernameKeys(profile.username);
  const reference = db.collection("users").doc(uid);
  const refs = keys.map((key) => ({
    key,
    ref: db.collection("usernameRegistry").doc(usernameRegistryId(key)),
  }));
  const [snapshot, ...registries] = await Promise.all([
    tx.get(reference),
    ...refs.map((row) => tx.get(row.ref)),
  ]);
  const current = snapshot.data() || {};
  if (registries.some((row) => row.exists && row.data()?.uid !== uid))
    throw fail("USERNAME_TAKEN", 409);
  if (
    current.profileInitializationPending !== true &&
    ["firstName", "lastName", "username", "birthDate"].some(
      (key) => current[key] && current[key] !== profile[key],
    )
  )
    throw fail("PROFILE_INITIALIZATION_LOCKED", 409);
  const legacy = await findUsernameProfiles(db, profile.username, {
    transaction: tx,
    includeRegistry: false,
  });
  if (legacy.some((row) => row.id !== uid)) throw fail("USERNAME_TAKEN", 409);
  const now = Date.now();
  const patch = {
    profileInitializationPending: false,
    email,
    firstName: current.firstName || profile.firstName,
    lastName: current.lastName || profile.lastName,
    fullName: current.fullName || `${profile.firstName} ${profile.lastName}`,
    username: profile.username,
    usernameLower: keys[0],
    birthDate: current.birthDate || profile.birthDate,
    ...(current.storeBalanceKurus === undefined
      ? { storeBalanceKurus: readStoredBalance(current) }
      : {}),
    storeProfile: current.storeProfile || { avatarId: "1" },
    ...(verificationRequired ? { registrationVerificationRequired: 1 } : {}),
    createdAt: Number(current.createdAt || now),
    updatedAt: now,
  };
  for (const row of refs)
    tx.set(
      row.ref,
      {
        uid,
        username: profile.username,
        usernameLower: row.key,
        updatedAt: now,
      },
      { merge: true },
    );
  tx.set(reference, patch, { merge: true });
  return {
    uid,
    email,
    firstName: patch.firstName,
    lastName: patch.lastName,
    fullName: patch.fullName,
    username: patch.username,
    birthDate: patch.birthDate,
  };
}
module.exports = { normalizeProfile, writeInitialProfile };
