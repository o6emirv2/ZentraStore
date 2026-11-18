"use strict";
const { recoveryConfiguration } = require("./config");
const { escape: e } = require("./templates");
function message({ kind, email, username = "", link = "", expiresAt, template = {} }) {
  const c = recoveryConfiguration(),
    reset = kind === "password";
  const title = reset ? "Şifreni güvenle yenile." : "Kullanıcı adını hatırla.";
  let subject =
    "ZENTRA STORE — " +
    (reset ? "Şifreni güvenle yenile" : "Kullanıcı adı hatırlatma");
  let action = reset ? "Şifremi Yenile" : "Hesabıma Giriş Yap";
  let body = reset
    ? "Hesabının şifresini yenilemek için aşağıdaki tek kullanımlık bağlantıyı kullan."
    : "Hesabına ait kayıtlı kullanıcı adı aşağıdadır.";
  const deadline = expiresAt
    ? new Date(expiresAt).toLocaleString("tr-TR", {
        timeZone: "Europe/Istanbul",
      })
    : "";
  const detail = reset
    ? `Bağlantı ${deadline} (Türkiye saati) tarihine kadar geçerlidir. Bu işlemi sen başlatmadıysan bağlantıyı kullanma; mevcut şifren değişmeden kalacaktır.`
    : "Bu talebi sen oluşturmadıysan iletiyi dikkate alma. Şifreni hatırlamıyorsan mağazadaki güvenli şifre yenileme seçeneğini kullan.";
  ({ subject, intro: body, label: action } = require("./editor").apply(template, {subject, intro: body, label: action}, {kullanici: username, tarih: deadline}));
  return {
    from: c.from,
    to: [email],
    subject,
    html: `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=0.85, viewport-fit=cover" /></head><body style="margin:0;background:#f1f5f6;color:#242b33;font-family:Arial,sans-serif"><table role="presentation" width="100%"><tr><td align="center" style="padding:28px 14px"><table role="presentation" width="100%" style="max-width:560px;border-radius:28px;background:white"><tr><td style="padding:32px"><img src="${e(c.origin)}/public/assets/images/logo.png" alt="ZENTRA STORE" width="64" height="64" style="border-radius:16px"><p style="color:#71209c;font-weight:bold;letter-spacing:2px;font-size:12px">ZENTRA STORE · HESAP GÜVENLİĞİ</p><h1 style="font-size:28px">${e(subject)}</h1><p style="line-height:1.7">${e(body)}</p>${reset ? "" : `<p style="background:#f5eafa;padding:20px;border-radius:18px;font-size:24px;font-weight:bold;word-break:break-word">${e(username)}</p>`}<p style="margin:28px 0"><a href="${e(link)}" style="display:inline-block;padding:16px 26px;border-radius:99px;background:#8d24ce;color:white;text-decoration:none;font-weight:bold">${e(action)}</a></p><p style="color:#64717e;font-size:14px;line-height:1.7">${e(detail)}</p><p style="font-size:12px;color:#64717e">Zentra senden e-posta yanıtıyla parola veya doğrulama kodu istemez.</p></td></tr></table></td></tr></table></body></html>`,
    text: `ZENTRA STORE\n\n${title}\n${body}\n${reset ? "" : "Kullanıcı adın: " + username + "\n"}\n${action}: ${link}\n\n${detail}`,
    ...(c.replyTo ? { reply_to: c.replyTo } : {}),
  };
}
module.exports = { message };
