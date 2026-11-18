import { escape as e, icon } from "./ui.js?v=108";

export function profileLabel(profile) {
  return profile?.kind === "member" && /^[\p{L}\p{N}._-]{1,40}$/u.test(profile.username || "")
    ? "@" + profile.username : profile?.kind === "guest" ? "Misafir" : "Zentra üyesi";
}

export function profileAvatar(profile) {
  const label = profileLabel(profile), member = profile?.kind === "member";
  let photo = "";
  try {
    const url = new URL(profile?.avatarUrl);
    if (member && url.protocol === "https:" && url.hostname === "encrypted-tbn0.gstatic.com" &&
        url.pathname === "/images" && !url.port && !url.username && !url.password && !url.hash &&
        /^tbn:ANd9Gc/i.test(url.searchParams.get("q") || "") && url.searchParams.get("s") === "10") photo = url.href;
  } catch {}
  return `<span class="community-avatar" aria-hidden="true"><span>${member ? e(label.slice(1, 2).toLocaleUpperCase("tr-TR")) : icon("user")}</span>${photo ? `<img data-community-avatar src="${e(photo)}" alt="" width="44" height="44" loading="lazy" decoding="async" referrerpolicy="no-referrer"/>` : ""}</span>`;
}

export function likerRow(person) {
  const profile = person.profile;
  return `<li class="community-person">${profileAvatar(profile)}<div><b>${e(profileLabel(profile))}</b><small>${profile?.kind === "guest" ? "Hesap açmadan beğendi" : profile?.kind === "member" ? "Bu ürünü beğendi" : "Profil bilgisi kullanılamıyor"}</small></div></li>`;
}
