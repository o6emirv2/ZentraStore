"use strict";
const { configuration, validEmail } = require("./config");
const { escape } = require("./templates");
function message({ code, expiresAt, email }) {
  const config = configuration();
  if (
    !/^\d{6}$/.test(code) ||
    !validEmail(email) ||
    !Number.isSafeInteger(expiresAt)
  )
    throw Object.assign(new Error("EMAIL_VERIFICATION_MESSAGE_INVALID"), {
      code: "EMAIL_VERIFICATION_MESSAGE_INVALID",
    });
  const logo = new URL("/public/assets/images/logo.png", config.origin).href;
  const deadline = new Intl.DateTimeFormat("tr-TR", {
    dateStyle: "short",
    timeStyle: "medium",
    timeZone: "Europe/Istanbul",
  }).format(expiresAt);
  return {
    from: config.from,
    to: [email],
    subject: "ZENTRA STORE · E-posta doğrulama kodun",
    html: `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=0.85, minimum-scale=0.85, maximum-scale=0.85, viewport-fit=cover" /><title>E-posta doğrulama · ZENTRA STORE</title></head><body style="margin:0;background:#f5f7fc;color:#17243d;font-family:Arial,sans-serif"><table role="presentation" width="100%"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" style="max-width:560px;background:#fff;border-radius:24px"><tr><td style="padding:28px"><img src="${escape(logo)}" alt="ZENTRA STORE" width="64" height="64" style="border-radius:14px"><p style="font-size:12px;font-weight:bold;letter-spacing:2px;color:#334ca5">ZENTRA STORE</p><h1 style="font-size:26px">E-postanı doğrula.</h1><p style="font-size:16px;line-height:1.7">İşlemine devam etmek için aşağıdaki tek kullanımlık kodu mağazadaki doğrulama ekranına gir.</p><p style="padding:22px 12px;background:#f0f3fc;border-radius:16px;text-align:center;font-family:monospace;font-weight:bold;font-size:36px;letter-spacing:8px">${code}</p><p style="font-size:14px;line-height:1.7">Kodun oluşturulduktan sonra <strong>5 dakika</strong> boyunca geçerlidir. Son kullanım: <strong>${escape(deadline)} (Türkiye saati)</strong>. Yeniden kod istediğinde önceki kod geçersiz olur.</p><p style="font-size:13px;line-height:1.7;color:#52617d">Bu işlemi sen başlatmadıysan bu e-postayı dikkate alma. Doğrulama kodunu kimseyle paylaşma.</p></td></tr></table></td></tr></table></body></html>`,
    text: `ZENTRA STORE\n\nE-posta doğrulama kodun: ${code}\n\nKod oluşturulduktan sonra 5 dakika geçerlidir ve bir kez kullanılabilir. Son kullanım: ${deadline} (Türkiye saati). Yeni kod istediğinde önceki kod geçersiz olur.\n\nBu işlemi sen başlatmadıysan bu e-postayı dikkate alma. Kodunu kimseyle paylaşma.`,
    ...(config.replyTo ? { reply_to: config.replyTo } : {}),
  };
}
async function send(input, { key, fetcher = global.fetch } = {}) {
  const config = configuration();
  if (!config.enabled || !config.configured)
    return {
      state: "failed",
      failureCode: "EMAIL_VERIFICATION_NOT_CONFIGURED",
    };
  const body = JSON.stringify(message(input));
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        headers: {
          authorization: "Bearer " + config.apiKey,
          "content-type": "application/json",
          "Idempotency-Key": key,
        },
        body,
      });
      const payload = await response.json().catch(() => null);
      if (
        response.ok &&
        typeof payload?.id === "string" &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
          payload.id,
        )
      )
        return { state: "accepted", providerId: payload.id, failureCode: "" };
      if (response.ok || response.status === 429 || response.status >= 500) {
        if (!attempt) continue;
        return {
          state: "uncertain",
          failureCode: "EMAIL_VERIFICATION_SEND_UNCERTAIN",
        };
      }
      return { state: "failed", failureCode: "EMAIL_VERIFICATION_SEND_FAILED" };
    } catch {
      if (attempt)
        return {
          state: "uncertain",
          failureCode: "EMAIL_VERIFICATION_SEND_UNCERTAIN",
        };
    }
  }
  return {
    state: "uncertain",
    failureCode: "EMAIL_VERIFICATION_SEND_UNCERTAIN",
  };
}
module.exports = { message, send };
