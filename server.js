const express = require("express");
const crypto = require("node:crypto");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const MONIME_API_BASE_URL = (
  process.env.MONIME_API_BASE_URL || "https://api.monime.io"
).replace(/\/+$/, "");
const MONIME_API_VERSION =
  process.env.MONIME_API_VERSION || "caph.2025-08-23";
const MOMO_PROVIDER_IDS = csv(process.env.MONIME_MOMO_PROVIDER_IDS);
const MONIME_TOKEN_ENV_BY_SERVICE = Object.freeze({
  checkoutSession: "MONIME_CHECKOUT_TOKEN",
  paymentCode: "MONIME_PAYMENT_CODE_TOKEN",
  payment: "MONIME_PAYMENT_TOKEN",
  receipt: "MONIME_RECEIPT_TOKEN",
});
const MONIME_ALLOW_TEST_TOKENS =
  process.env.MONIME_ALLOW_TEST_TOKENS === "true";

class AppError extends Error {
  constructor(message, status = 400, details = {}) {
    super(message);
    this.name = "AppError";
    this.status = status;
    Object.assign(this, details);
  }
}

class MonimeApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "MonimeApiError";
    this.status = details.status || 502;
    this.path = details.path;
    this.requestId = details.requestId;
    this.body = details.body;
  }
}

function csv(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function requiredString(value, field) {
  if (!isNonEmptyString(value)) {
    throw new AppError(`"${field}" is required and must be a non-empty string.`);
  }
  return value.trim();
}

function positiveMinorAmount(value, field = "amountMinor") {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new AppError(
      `"${field}" must be a positive integer in the currency's minor unit.`
    );
  }
  return amount;
}

function optionalUrl(value, field) {
  if (value == null || value === "") return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
    return url.toString();
  } catch {
    throw new AppError(`"${field}" must be a valid http(s) URL.`);
  }
}

function cleanMetadata(metadata) {
  if (metadata == null) return undefined;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new AppError('"metadata" must be an object of string values.');
  }

  const result = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!isNonEmptyString(key) || typeof value !== "string") {
      throw new AppError('"metadata" keys and values must be strings.');
    }
    result[key] = value;
  }
  return result;
}

function resolveMonimeToken(service) {
  const serviceEnvName = MONIME_TOKEN_ENV_BY_SERVICE[service];
  const candidates = [
    serviceEnvName ? [serviceEnvName, process.env[serviceEnvName]] : null,
    ["MONIME_API_TOKEN", process.env.MONIME_API_TOKEN],
  ].filter(Boolean);

  for (const [envName, value] of candidates) {
    if (isNonEmptyString(value)) {
      return { envName, token: value.trim() };
    }
  }

  return {
    envName: serviceEnvName || "MONIME_API_TOKEN",
    token: undefined,
  };
}

function tokenEnvironment(token) {
  if (!isNonEmptyString(token)) return "unknown";
  if (token.startsWith("mon_test_")) return "test";
  if (token.startsWith("mon_")) return "live";
  return "unknown";
}

function requireMonimeConfig(service) {
  const resolvedToken = resolveMonimeToken(service);
  if (!resolvedToken.token) {
    throw new AppError(
      `${resolvedToken.envName} is not configured on the server.`,
      500
    );
  }
  if (!isNonEmptyString(process.env.MONIME_SPACE_ID)) {
    throw new AppError(
      "MONIME_SPACE_ID is not configured on the server.",
      500
    );
  }
  if (
    tokenEnvironment(resolvedToken.token) === "test" &&
    !MONIME_ALLOW_TEST_TOKENS
  ) {
    throw new AppError(
      `${resolvedToken.envName} is a test token. Create the token with Test Mode turned off for live payments.`,
      500
    );
  }
  return resolvedToken.token;
}

function idempotencyKey(req) {
  const supplied =
    req.get("Idempotency-Key") ||
    req.get("X-Idempotency-Key") ||
    req.body?.idempotencyKey;
  const key = supplied || crypto.randomUUID();

  if (!isNonEmptyString(key) || key.length > 64) {
    throw new AppError(
      "Idempotency-Key must be a non-empty string of 64 characters or fewer."
    );
  }
  return key;
}

function getRequestId(response) {
  return (
    response.headers.get("x-request-id") ||
    response.headers.get("request-id") ||
    response.headers.get("monime-request-id") ||
    undefined
  );
}

async function monimeRequest(path, options = {}) {
  const token = requireMonimeConfig(options.service);

  const method = options.method || "GET";
  const headers = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "Monime-Space-Id": process.env.MONIME_SPACE_ID,
    "Monime-Version": MONIME_API_VERSION,
    ...(options.headers || {}),
  };

  let body;
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(`${MONIME_API_BASE_URL}${path}`, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    throw new MonimeApiError("Could not reach Monime.", {
      path,
      body: { cause: error.message },
    });
  }

  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  if (!response.ok || (parsed && parsed.success === false)) {
    const message =
      parsed?.message ||
      parsed?.error?.message ||
      parsed?.error ||
      `Monime returned HTTP ${response.status}.`;

    throw new MonimeApiError(String(message), {
      status: response.status,
      path,
      requestId: getRequestId(response),
      body: parsed,
    });
  }

  return {
    status: response.status,
    requestId: getRequestId(response),
    body: parsed,
  };
}

function amountObject(body) {
  return {
    currency: body.currency || "SLE",
    value: positiveMinorAmount(body.amountMinor),
  };
}

function mobileMoneyOnlyOptions(providers) {
  const enabledProviders = providers?.length ? providers : MOMO_PROVIDER_IDS;
  const momo = { disable: false };
  if (enabledProviders.length) momo.enabledProviders = enabledProviders;

  // Explicitly disable every non-Mobile-Money channel.
  return {
    card: { disable: true },
    bank: { disable: true },
    wallet: { disable: true },
    momo,
  };
}

function providerList(value) {
  if (value == null) return undefined;
  const providers = Array.isArray(value) ? value : csv(value);
  if (!providers.length) {
    throw new AppError(
      '"allowedMomoProviders" must contain at least one provider ID.'
    );
  }
  if (providers.some((item) => !isNonEmptyString(item))) {
    throw new AppError(
      '"allowedMomoProviders" must contain valid Monime Mobile Money provider IDs.'
    );
  }
  return [...new Set(providers.map((item) => item.trim()))];
}

function commonReference(body) {
  if (body.reference == null) return undefined;
  return requiredString(body.reference, "reference");
}

function addCommonResponseHeaders(res, result) {
  if (result?.requestId) res.set("Monime-Request-Id", result.requestId);
}

function normalizeCustomer(body) {
  if (!body.customerName && !body.customer) return undefined;
  if (body.customer && typeof body.customer !== "object") {
    throw new AppError('"customer" must be an object.');
  }
  const name = body.customer?.name || body.customerName;
  return name ? { name: requiredString(name, "customer.name") } : undefined;
}

/*
 * CORS is intentionally open for this service because the caller requested
 * support for any frontend. Do not enable credentials with wildcard origins.
 */
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Idempotency-Key, X-Idempotency-Key"
  );
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PATCH, DELETE, OPTIONS"
  );
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buffer) => {
      req.rawBody = Buffer.from(buffer);
    },
  })
);

app.get("/", (_req, res) => {
  res.json({
    service: "monime-mobile-money-deposits",
    mobileMoneyOnly: true,
    endpoints: {
      health: "GET /health",
      createCheckoutSession: "POST /api/deposits/checkout-sessions",
      createPaymentCode: "POST /api/deposits/payment-codes",
      getCheckoutSession: "GET /api/deposits/checkout-sessions/:id",
      getPayment: "GET /api/deposits/payments/:id",
      getReceipt: "GET /api/deposits/receipts/:orderNumber",
      monimeWebhook: "POST /webhooks/monime",
    },
  });
});

app.get("/health", (_req, res) => {
  const serviceTokens = Object.fromEntries(
    Object.entries(MONIME_TOKEN_ENV_BY_SERVICE).map(([service, envName]) => {
      const resolved = resolveMonimeToken(service);
      return [
        service,
        {
          configured: Boolean(resolved.token),
          source: resolved.token ? resolved.envName : envName,
          environment: tokenEnvironment(resolved.token),
        },
      ];
    })
  );
  const configuredEnvironments = [
    ...new Set(
      Object.values(serviceTokens)
        .map((item) => item.environment)
        .filter((environment) => environment !== "unknown")
    ),
  ];

  res.json({
    ok: true,
    service: "monime-mobile-money-deposits",
    mobileMoneyOnly: true,
    monime: {
      apiBaseUrl: MONIME_API_BASE_URL,
      apiVersion: MONIME_API_VERSION,
      tokenConfigured: Object.values(serviceTokens).some(
        (item) => item.configured
      ),
      spaceConfigured: Boolean(process.env.MONIME_SPACE_ID),
      environment:
        configuredEnvironments.length === 1
          ? configuredEnvironments[0]
          : configuredEnvironments.length
            ? "mixed"
            : "unknown",
      testTokensAllowed: MONIME_ALLOW_TEST_TOKENS,
      serviceTokens,
    },
    timestamp: new Date().toISOString(),
  });
});

/*
 * Creates a hosted Monime payment link. The link is a Checkout Session URL,
 * not a permanent reusable payment-link object.
 */
app.post("/api/deposits/checkout-sessions", async (req, res, next) => {
  try {
    const body = req.body || {};
    const name = requiredString(body.name || "Mobile Money Deposit", "name");
    const amount = amountObject(body);
    const providers = providerList(body.allowedMomoProviders);

    const lineItem = {
      type: "custom",
      name,
      price: amount,
      quantity: 1,
    };
    if (body.description) {
      lineItem.description = String(body.description).slice(0, 1000);
    }

    const payload = {
      name,
      description: body.description
        ? String(body.description).slice(0, 1000)
        : undefined,
      cancelUrl:
        optionalUrl(
          body.cancelUrl || process.env.MONIME_CANCEL_URL,
          "cancelUrl"
        ) || undefined,
      successUrl:
        optionalUrl(
          body.successUrl || process.env.MONIME_SUCCESS_URL,
          "successUrl"
        ) || undefined,
      callbackState:
        body.callbackState == null
          ? undefined
          : String(body.callbackState).slice(0, 255),
      reference: commonReference(body),
      financialAccountId: body.financialAccountId
        ? requiredString(body.financialAccountId, "financialAccountId")
        : undefined,
      lineItems: [lineItem],
      paymentOptions: mobileMoneyOnlyOptions(providers),
      metadata: cleanMetadata(body.metadata),
    };

    const result = await monimeRequest("/v1/checkout-sessions", {
      method: "POST",
      service: "checkoutSession",
      headers: { "Idempotency-Key": idempotencyKey(req) },
      body: removeUndefined(payload),
    });
    addCommonResponseHeaders(res, result);
    res.status(result.status).json({
      ok: true,
      mobileMoneyOnly: true,
      result: result.body?.result ?? result.body,
    });
  } catch (error) {
    next(error);
  }
});

/*
 * Creates a USSD/QR Payment Code. Payment Codes are Mobile Money collection
 * primitives in Monime and can be one-time or recurrent.
 */
app.post("/api/deposits/payment-codes", async (req, res, next) => {
  try {
    const body = req.body || {};
    const mode = body.mode || "one_time";
    if (!["one_time", "recurrent"].includes(mode)) {
      throw new AppError('"mode" must be "one_time" or "recurrent".');
    }

    const name = requiredString(body.name || "Mobile Money Deposit", "name");
    const amount = amountObject(body);
    const providers = providerList(body.authorizedMomoProviders);
    const payload = {
      mode,
      name,
      enable: body.enable !== false,
      amount,
      duration: body.duration || undefined,
      customer: normalizeCustomer(body),
      reference: commonReference(body),
      authorizedProviders: providers,
      authorizedPhoneNumber: body.authorizedPhoneNumber
        ? requiredString(
            body.authorizedPhoneNumber,
            "authorizedPhoneNumber"
          )
        : undefined,
      financialAccountId: body.financialAccountId
        ? requiredString(body.financialAccountId, "financialAccountId")
        : undefined,
      recurrentPaymentTarget:
        mode === "recurrent" && body.recurrentPaymentTarget
          ? body.recurrentPaymentTarget
          : undefined,
      metadata: cleanMetadata(body.metadata),
    };

    const result = await monimeRequest("/v1/payment-codes", {
      method: "POST",
      service: "paymentCode",
      headers: { "Idempotency-Key": idempotencyKey(req) },
      body: removeUndefined(payload),
    });
    addCommonResponseHeaders(res, result);
    res.status(result.status).json({
      ok: true,
      mobileMoneyOnly: true,
      result: result.body?.result ?? result.body,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/deposits/checkout-sessions/:id", async (req, res, next) => {
  try {
    const result = await monimeRequest(
      `/v1/checkout-sessions/${encodeURIComponent(requiredString(req.params.id, "id"))}`,
      { service: "checkoutSession" }
    );
    addCommonResponseHeaders(res, result);
    res.json({ ok: true, result: result.body?.result ?? result.body });
  } catch (error) {
    next(error);
  }
});

app.get("/api/deposits/payments/:id", async (req, res, next) => {
  try {
    const result = await monimeRequest(
      `/v1/payments/${encodeURIComponent(requiredString(req.params.id, "id"))}`,
      { service: "payment" }
    );
    addCommonResponseHeaders(res, result);
    res.json({ ok: true, result: result.body?.result ?? result.body });
  } catch (error) {
    next(error);
  }
});

app.get("/api/deposits/receipts/:orderNumber", async (req, res, next) => {
  try {
    const result = await monimeRequest(
      `/v1/receipts/${encodeURIComponent(
        requiredString(req.params.orderNumber, "orderNumber")
      )}`,
      { service: "receipt" }
    );
    addCommonResponseHeaders(res, result);
    res.json({ ok: true, result: result.body?.result ?? result.body });
  } catch (error) {
    next(error);
  }
});

/*
 * Configure a Monime webhook to POST checkout_session.completed,
 * checkout_session.expired, checkout_session.cancelled, and relevant
 * payment_code events here.
 *
 * Monime's public HMAC guide currently does not document the signature header
 * name. If MONIME_WEBHOOK_SECRET is supplied, the header name can be set with
 * MONIME_WEBHOOK_SIGNATURE_HEADER. Verification accepts hex/base64 SHA-256
 * HMAC values, including sha256= or v1= prefixes.
 */
app.post("/webhooks/monime", (req, res, next) => {
  try {
    if (process.env.MONIME_WEBHOOK_SECRET) {
      const headerName =
        process.env.MONIME_WEBHOOK_SIGNATURE_HEADER || "Monime-Signature";
      const supplied = req.get(headerName);
      if (!supplied || !verifyHmac(req.rawBody || Buffer.from(""), supplied)) {
        throw new AppError("Invalid Monime webhook signature.", 401);
      }
    }

    const event = req.body || {};
    console.log(
      JSON.stringify({
        receivedAt: new Date().toISOString(),
        event: event.event?.name || event.name || "unknown",
        objectId: event.object?.id || event.data?.id,
      })
    );

    // Monime creates receipts after successful payment. Retrieve one through
    // GET /api/deposits/receipts/:orderNumber once the order number is known.
    res.status(200).json({ ok: true, received: true });
  } catch (error) {
    next(error);
  }
});

function verifyHmac(rawBody, suppliedHeader) {
  const normalized = String(suppliedHeader)
    .trim()
    .replace(/^(sha256=|v1=)/i, "");
  const digestHex = crypto
    .createHmac("sha256", process.env.MONIME_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");
  const digestBase64 = crypto
    .createHmac("sha256", process.env.MONIME_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("base64");

  return [digestHex, digestBase64].some((expected) => {
    const a = Buffer.from(normalized);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

function removeUndefined(value) {
  if (Array.isArray(value)) {
    return value.map(removeUndefined);
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, removeUndefined(item)])
  );
}

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    error: {
      type: "not_found",
      message: `Route ${req.method} ${req.path} was not found.`,
    },
  });
});

app.use((error, _req, res, _next) => {
  const status = Number(error.status) || 500;
  const response = {
    ok: false,
    error: {
      type:
        error instanceof MonimeApiError
          ? "monime_api_error"
          : error instanceof AppError
            ? "application_error"
            : "internal_error",
      message: error.message || "Unexpected server error.",
    },
  };

  if (error instanceof MonimeApiError) {
    response.error.status = error.status;
    response.error.path = error.path;
    response.error.requestId = error.requestId;
    // This is the unmodified parsed Monime response, including its real error
    // code/messages. Secrets are never included here.
    response.error.monime = error.body;
  }

  if (status >= 500 && !(error instanceof MonimeApiError)) {
    console.error(error);
  }
  res.status(status).json(response);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Monime Mobile Money deposit server listening on 0.0.0.0:${PORT}`
  );
});