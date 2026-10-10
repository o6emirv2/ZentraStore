export function accountViewModel({ user = null, account = null, busy = false } = {}) {
  const loaded = !!user && !!account;
  const email = user ? String(account?.email || user.email || '—') : '—';
  const changes = account?.profileChanges || {};
  const remaining = (field, fallback) => loaded ? Math.max(0, Math.trunc(Number(changes[field]?.remaining ?? fallback) || 0)) : null;
  const birth = String(account?.birthDate || '');
  return {
    loaded, email,
    username: user ? String(account?.username || user.displayName || 'Üye') : '—',
    fullName: loaded ? String(account.fullName || [account.firstName, account.lastName].filter(Boolean).join(' ') || 'Henüz eklenmedi') : '—',
    birthDate: loaded ? (/^\d{4}-\d{2}-\d{2}$/.test(birth) ? birth.split('-').reverse().join('.') : 'Henüz eklenmedi') : '—',
    emailStatus: user?.emailVerified === true ? 'Doğrulanmış e-posta' : user ? 'Kayıtlı e-posta' : 'Oturum gerekli',
    status: !loaded ? 'Hesap yükleniyor…' : account.accountStatus === 'suspended' ? 'Hesap askıya alındı' : account.accountStatus === 'purchase_blocked' ? 'Satın alma kısıtlı' : 'Etkin hesap',
    warning: loaded && !!account.accountStatus && account.accountStatus !== 'active',
    canEdit: loaded && !busy,
    remaining: { username: remaining('username', 3), fullName: remaining('fullName', 1), birthDate: remaining('birthDate', 1) }
  };
}

export function updateAccountView(root, options = {}) {
  if (!root) return;
  const model = accountViewModel(options);
  const write = (id, value) => { const node = root.querySelector(`#${id}`); if (node) node.textContent = value; };
  root.querySelector('#customerViewProfile')?.setAttribute('aria-busy', String(!!options.user && !model.loaded));
  write('accountUsername', model.username);
  write('accountEmail', model.email);
  write('accountStatusLabel', model.status);
  root.querySelector('#accountStatusLabel')?.classList.toggle('is-warning', model.warning);
  write('accountBalance', model.loaded ? options.formatBalance?.(options.account.balanceKurus) || '—' : '—');
  write('accountBalanceDescription', model.loaded ? 'Alışverişlerinizde kullanabileceğiniz bakiye' : 'Bakiyeniz yükleniyor…');
  write('accountEmailSecurityDetail', model.email);
  write('accountEmailSecurityStatus', model.emailStatus);
  const fields = [
    ['username', 'accountUsernameActionButton', 'accountUsernameDetail', 'accountUsernameRemaining', model.username],
    ['fullName', 'accountNameActionButton', 'accountFullNameDetail', 'accountNameRemaining', model.fullName],
    ['birthDate', 'accountBirthDateActionButton', 'accountBirthDateDetail', 'accountBirthDateRemaining', model.birthDate]
  ];
  for (const [field, id, detail, badge, value] of fields) {
    const remaining = model.remaining[field];
    write(detail, value);
    write(badge, remaining === null ? '—' : remaining ? `${remaining} değişiklik` : 'Sınır doldu');
    const button = root.querySelector(`#${id}`);
    if (button) { button.disabled = !model.canEdit || !remaining; button.setAttribute('aria-disabled', String(button.disabled)); }
  }
  for (const id of ['accountEmailActionButton', 'accountPasswordActionButton']) {
    const button = root.querySelector(`#${id}`);
    if (button) button.disabled = !model.canEdit;
  }
  write('accountUsernameModalRemaining', model.remaining.username === null ? '—' : String(model.remaining.username));
}
