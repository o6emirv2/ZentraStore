export function recoveryToken(href) {
  try {
    const url = new URL(href);
    const fragment = new URLSearchParams(url.hash.slice(1));
    const values = fragment.getAll("recovery");
    return values.length === 1 && /^[-_A-Za-z0-9]{43}$/.test(values[0])
      ? values[0] : "";
  } catch {
    return "";
  }
}
