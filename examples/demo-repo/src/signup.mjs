export function validateSignup(input) {
  const errors = [];
  const email = typeof input.email === "string" ? input.email.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";

  if (!email.includes("@") || email.startsWith("@") || email.endsWith("@")) {
    errors.push("email must be a valid email address");
  }

  if (password.length < 8) {
    errors.push("password must be at least 8 characters");
  }

  return {
    errors,
    ok: errors.length === 0
  };
}

export function createSignupPayload(input) {
  const validation = validateSignup(input);

  if (!validation.ok) {
    return {
      status: 400,
      body: {
        errors: validation.errors
      }
    };
  }

  return {
    status: 201,
    body: {
      email: input.email.trim().toLowerCase()
    }
  };
}
