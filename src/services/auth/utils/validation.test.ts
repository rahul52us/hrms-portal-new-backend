import assert from "node:assert/strict";
import {
  UserValidation,
  adminRegistrationValidation,
  bootstrapSuperadminValidation,
  changePasswordValidation,
  forgotEmailValidation,
  learnerRegistrationValidation,
  passwordLoginValidation,
  resetPasswordValidation,
} from "./validation";

const PASSWORD_RULE_MESSAGE =
  "Password must contain at least 8 characters, including one uppercase letter, one lowercase letter, and one digit.";

const STRONG_PASSWORD = "Passw0rdOK";

function messagesOf(error: { details: { message: string }[] } | undefined) {
  return (error?.details || []).map((detail) => detail.message);
}

function validLocation() {
  return {
    address: "12 MG Road",
    city: "Mumbai",
    state: "Maharashtra",
    country: "India",
    postalCode: "400001",
  };
}

function testPasswordLoginAcceptsAndNormalizesUsername() {
  const { error, value } = passwordLoginValidation.validate({
    username: "  User@Example.COM ",
    password: "12345678",
  });

  assert.equal(error, undefined);
  assert.equal(value.username, "user@example.com");
}

function testPasswordLoginRejectsBadInput() {
  const badEmail = passwordLoginValidation.validate({
    username: "not-an-email",
    password: "12345678",
  });
  assert.ok(messagesOf(badEmail.error).includes("Username must be a valid email address"));

  const empty = passwordLoginValidation.validate({});
  assert.ok(messagesOf(empty.error).includes("Username is required"));
  assert.ok(messagesOf(empty.error).includes("Password is required"));

  const blankPassword = passwordLoginValidation.validate({
    username: "user@example.com",
    password: "",
  });
  assert.ok(messagesOf(blankPassword.error).includes("Password is required"));
}

function testPasswordLoginEnforcesLengthBounds() {
  const tooShort = passwordLoginValidation.validate({
    username: "user@example.com",
    password: "1234567",
  });
  assert.ok(tooShort.error, "7 characters is too short");

  const tooLong = passwordLoginValidation.validate({
    username: "user@example.com",
    password: "a".repeat(129),
  });
  assert.ok(tooLong.error, "129 characters is too long");

  const atLimit = passwordLoginValidation.validate({
    username: "user@example.com",
    password: "a".repeat(128),
  });
  assert.equal(atLimit.error, undefined);
}

function testForgotEmailValidation() {
  assert.equal(forgotEmailValidation.validate({ username: "user@example.com" }).error, undefined);

  const invalid = forgotEmailValidation.validate({ username: "nope" });
  assert.deepEqual(messagesOf(invalid.error), ["Username should be a valid email address"]);

  const missing = forgotEmailValidation.validate({});
  assert.deepEqual(messagesOf(missing.error), ["Username is required"]);
}

function testResetPasswordRequiresStrongPasswordAndToken() {
  assert.equal(
    resetPasswordValidation.validate({ password: STRONG_PASSWORD, token: "abc123" }).error,
    undefined
  );

  const weak = resetPasswordValidation.validate({ password: "password", token: "abc123" });
  assert.deepEqual(messagesOf(weak.error), [PASSWORD_RULE_MESSAGE]);

  const missingToken = resetPasswordValidation.validate({ password: STRONG_PASSWORD });
  assert.match(messagesOf(missingToken.error)[0], /Token is\s+required/);
}

function testPasswordStrengthRuleBoundaries() {
  const cases: Array<[string, boolean]> = [
    ["Passw0rd", true], // exactly 8 characters
    ["Passw0r", false], // 7 characters
    ["password1", false], // no uppercase
    ["PASSWORD1", false], // no lowercase
    ["Password", false], // no digit
    ["Passw0rd!@#", true], // symbols are allowed
  ];

  for (const [password, shouldPass] of cases) {
    const { error } = resetPasswordValidation.validate({ password, token: "t" });
    assert.equal(error === undefined, shouldPass, `password "${password}"`);
  }
}

function testLearnerRegistrationAcceptsValidPayloadAndNormalizes() {
  const { error, value } = learnerRegistrationValidation.validate({
    name: "  Asha Rao ",
    phone: "9876543210",
    username: "  Asha@Example.com ",
    verificationToken: "verify-token",
    location: validLocation(),
  });

  assert.equal(error, undefined);
  assert.equal(value.name, "Asha Rao");
  assert.equal(value.username, "asha@example.com");
}

function testLearnerRegistrationRejectsInvalidPhone() {
  for (const phone of ["12345", "98765432101", "98765abcde", ""]) {
    const { error } = learnerRegistrationValidation.validate({
      name: "Asha Rao",
      phone,
      username: "asha@example.com",
      verificationToken: "verify-token",
      location: validLocation(),
    });
    assert.ok(error, `phone "${phone}" should be rejected`);
  }

  const wrongPattern = learnerRegistrationValidation.validate({
    name: "Asha Rao",
    phone: "12345",
    username: "asha@example.com",
    verificationToken: "verify-token",
    location: validLocation(),
  });
  assert.ok(messagesOf(wrongPattern.error).includes("Phone must be a valid 10-digit number"));
}

function testLearnerRegistrationRequiresTokenAndLocation() {
  const missingToken = learnerRegistrationValidation.validate({
    name: "Asha Rao",
    phone: "9876543210",
    username: "asha@example.com",
    location: validLocation(),
  });
  assert.ok(messagesOf(missingToken.error).includes("Verification token is required"));

  const missingLocation = learnerRegistrationValidation.validate({
    name: "Asha Rao",
    phone: "9876543210",
    username: "asha@example.com",
    verificationToken: "verify-token",
  });
  assert.ok(missingLocation.error, "location is required");

  const incompleteLocation = learnerRegistrationValidation.validate({
    name: "Asha Rao",
    phone: "9876543210",
    username: "asha@example.com",
    verificationToken: "verify-token",
    location: { address: "12 MG Road" },
  });
  const messages = messagesOf(incompleteLocation.error);
  assert.ok(messages.includes("City is required"));
  assert.ok(messages.includes("State is required"));
  assert.ok(messages.includes("Country is required"));
  assert.ok(messages.includes("Pincode is required"));
}

function testLocationCoordinateBounds() {
  const build = (lat: number | null, lng: number | null) =>
    learnerRegistrationValidation.validate({
      name: "Asha Rao",
      phone: "9876543210",
      username: "asha@example.com",
      verificationToken: "verify-token",
      location: { ...validLocation(), lat, lng },
    });

  assert.equal(build(19.07, 72.87).error, undefined);
  assert.equal(build(90, 180).error, undefined);
  assert.equal(build(-90, -180).error, undefined);
  assert.equal(build(null, null).error, undefined, "null coordinates are allowed");
  assert.ok(build(90.1, 0).error, "latitude above 90");
  assert.ok(build(-90.1, 0).error, "latitude below -90");
  assert.ok(build(0, 180.1).error, "longitude above 180");
  assert.ok(build(0, -180.1).error, "longitude below -180");
}

function testAdminRegistrationRequiresCompanyName() {
  const base = {
    name: "Ravi Kumar",
    phone: "9876543210",
    username: "ravi@example.com",
    verificationToken: "verify-token",
    location: validLocation(),
  };

  const ok = adminRegistrationValidation.validate({ ...base, companyName: "Acme Pvt Ltd" });
  assert.equal(ok.error, undefined);

  const missing = adminRegistrationValidation.validate(base);
  assert.ok(messagesOf(missing.error).includes("Company name is required"));

  const blank = adminRegistrationValidation.validate({ ...base, companyName: "" });
  assert.ok(messagesOf(blank.error).includes("Company name is required"));
}

function testAdminRegistrationNormalizesCompanyEmail() {
  const { error, value } = adminRegistrationValidation.validate({
    name: "Ravi Kumar",
    phone: "9876543210",
    username: "ravi@example.com",
    verificationToken: "verify-token",
    companyName: "Acme Pvt Ltd",
    companyEmail: "  HR@Acme.COM ",
    location: validLocation(),
  });

  assert.equal(error, undefined);
  assert.equal(value.companyEmail, "hr@acme.com");

  const invalid = adminRegistrationValidation.validate({
    name: "Ravi Kumar",
    phone: "9876543210",
    username: "ravi@example.com",
    verificationToken: "verify-token",
    companyName: "Acme Pvt Ltd",
    companyEmail: "not-an-email",
    location: validLocation(),
  });
  assert.ok(invalid.error);
}

function testBootstrapSuperadminValidation() {
  const ok = bootstrapSuperadminValidation.validate({
    name: "Root Admin",
    username: "root@example.com",
    password: STRONG_PASSWORD,
  });
  assert.equal(ok.error, undefined, "phone and setupKey are optional");

  const withOptional = bootstrapSuperadminValidation.validate({
    name: "Root Admin",
    username: "root@example.com",
    password: STRONG_PASSWORD,
    phone: "9876543210",
    setupKey: "",
  });
  assert.equal(withOptional.error, undefined, "empty setupKey is allowed");

  const weak = bootstrapSuperadminValidation.validate({
    name: "Root Admin",
    username: "root@example.com",
    password: "weak",
  });
  assert.ok(messagesOf(weak.error).includes(PASSWORD_RULE_MESSAGE));

  const shortName = bootstrapSuperadminValidation.validate({
    name: "R",
    username: "root@example.com",
    password: STRONG_PASSWORD,
  });
  assert.ok(shortName.error, "name shorter than 2 characters");

  const badPhone = bootstrapSuperadminValidation.validate({
    name: "Root Admin",
    username: "root@example.com",
    password: STRONG_PASSWORD,
    phone: "123",
  });
  assert.ok(messagesOf(badPhone.error).includes("Phone must be a valid 10-digit number"));
}

function testChangePasswordValidation() {
  assert.equal(
    changePasswordValidation.validate({
      oldPassword: STRONG_PASSWORD,
      newPassword: "N3wPassword",
    }).error,
    undefined
  );

  assert.equal(
    changePasswordValidation.validate({
      oldPassword: STRONG_PASSWORD,
      newPassword: "N3wPassword",
      company: "company-id",
    }).error,
    undefined,
    "company is optional context"
  );

  const weakNew = changePasswordValidation.validate({
    oldPassword: STRONG_PASSWORD,
    newPassword: "weak",
  });
  assert.deepEqual(messagesOf(weakNew.error), [PASSWORD_RULE_MESSAGE]);

  const missingNew = changePasswordValidation.validate({ oldPassword: STRONG_PASSWORD });
  assert.ok(missingNew.error);
}

function testUserValidationForNonAdminRequiresCoreFields() {
  const ok = UserValidation.validate({
    name: "Meera",
    username: "meera01",
    role: "user",
    company: "company-id",
    password: STRONG_PASSWORD,
  });
  assert.equal(ok.error, undefined);

  const missingEverything = UserValidation.validate({ role: "user" });
  const messages = messagesOf(missingEverything.error);
  assert.ok(messages.includes("Name is required"));
  assert.ok(messages.includes("Username is required"));
  assert.ok(messages.includes("Please select the company"));
  assert.ok(messages.some((message) => message.includes("\"password\" is required")));
}

function testUserValidationNameAndUsernameLengths() {
  const shortName = UserValidation.validate({
    name: "Al",
    username: "meera01",
    role: "user",
    company: "company-id",
    password: STRONG_PASSWORD,
  });
  assert.ok(messagesOf(shortName.error).includes("Name must have a minimum length of 3"));

  const longName = UserValidation.validate({
    name: "A".repeat(31),
    username: "meera01",
    role: "user",
    company: "company-id",
    password: STRONG_PASSWORD,
  });
  assert.ok(messagesOf(longName.error).includes("Name should not exceed a maximum length of 30"));

  const shortUsername = UserValidation.validate({
    name: "Meera",
    username: "mee",
    role: "user",
    company: "company-id",
    password: STRONG_PASSWORD,
  });
  assert.ok(
    messagesOf(shortUsername.error).includes("username must have a minimum length of 5")
  );
}

function testUserValidationAdminRoleRelaxesNameCompanyAndPassword() {
  const { error } = UserValidation.validate({
    username: "adminuser",
    role: "admin",
  });

  assert.equal(error, undefined);
}

function testUserValidationRejectsUnknownRole() {
  const { error } = UserValidation.validate({
    name: "Meera",
    username: "meera01",
    role: "hacker",
    company: "company-id",
    password: STRONG_PASSWORD,
  });

  assert.ok(error);
}

testPasswordLoginAcceptsAndNormalizesUsername();
testPasswordLoginRejectsBadInput();
testPasswordLoginEnforcesLengthBounds();
testForgotEmailValidation();
testResetPasswordRequiresStrongPasswordAndToken();
testPasswordStrengthRuleBoundaries();
testLearnerRegistrationAcceptsValidPayloadAndNormalizes();
testLearnerRegistrationRejectsInvalidPhone();
testLearnerRegistrationRequiresTokenAndLocation();
testLocationCoordinateBounds();
testAdminRegistrationRequiresCompanyName();
testAdminRegistrationNormalizesCompanyEmail();
testBootstrapSuperadminValidation();
testChangePasswordValidation();
testUserValidationForNonAdminRequiresCoreFields();
testUserValidationNameAndUsernameLengths();
testUserValidationAdminRoleRelaxesNameCompanyAndPassword();
testUserValidationRejectsUnknownRole();

console.log("Auth validation schema tests passed");
