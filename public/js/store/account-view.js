export function accountViewModel({ user = null, account = null, busy = false, pendingEmail = '', error = '', loading = false } = {}) {
  const loaded = !!user && !!account;
  const email = user ? String(account?.email || user.email || '—') : '—';
  const changes = account?.profileChanges || {};
  const remaining = (field) => {
    const value = changes[field]?.remaining;
    return loaded && Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const birth = String(account?.birthDate || '');
  return {
    loaded, email, pendingEmail: user ? String(pendingEmail || '') : '',
    username: user ? String(account?.username || user.displayName || 'Üye') : '—',
    fullName: loaded ? String(account.fullName || [account.firstName, account.lastName].filter(Boolean).join(' ') || 'Henüz eklenmedi') : '—',
    birthDate: loaded ? (/^\d{4}-\d{2}-\d{2}$/.test(birth) ? birth.split('-').reverse().join('.') : 'Henüz eklenmedi') : '—',
    emailStatus: user?.emailVerified === true ? 'Doğrulanmış e-posta' : user ? 'Kayıtlı e-posta' : 'Oturum gerekli',
    status: !loaded ? error ? 'Hesap bilgileri yüklenemedi' : loading ? 'Hesap yükleniyor…' : 'Hesap bilgilerini yenileyin' : account.accountStatus === 'suspended' ? 'Hesap askıya alındı' : account.accountStatus === 'purchase_blocked' ? 'Satın alma kısıtlı' : 'Etkin hesap',
    warning: !!error || (loaded && !!account.accountStatus && account.accountStatus !== 'active'),
    canEdit: loaded && !busy,
    remaining: { username: remaining('username'), fullName: remaining('fullName'), birthDate: remaining('birthDate') }
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
  write('accountBalanceDescription', options.stale ? 'Son doğrulanan bakiye · İşlem öncesinde hesap bilgilerinizi yenileyin.' : model.loaded && options.account.walletDebtKurus > 0
    ? `Doğrulanmış iade nedeniyle ${options.formatBalance?.(options.account.walletDebtKurus) || 'bekleyen tutar'} kapatılmalıdır. Yeni yüklemeniz önce bu tutarı karşılar; tamamlanana kadar satın alma sınırlandırılır.`
    : model.loaded ? 'Alışverişlerinizde kullanabileceğiniz bakiye' : options.loading ? 'Bakiyeniz yükleniyor…' : 'Bakiyenizi görmek için hesabınızı yenileyin.');
  write('accountEmailSecurityDetail', model.email);
  const currentEmail = root.querySelector('#accountCurrentEmail');
  if (currentEmail) currentEmail.value = model.email;
  write('accountEmailSecurityStatus', model.pendingEmail ? 'Yeni adres doğrulama bekliyor' : model.emailStatus);
  const pending = root.querySelector('#accountEmailPending');
  if (pending) pending.hidden = !model.pendingEmail;
  write('accountPendingEmailText', model.pendingEmail ? `${model.pendingEmail} adresine gönderilen bağlantıyı onaylayın. Mevcut adresiniz onaya kadar korunur.` : '');
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
