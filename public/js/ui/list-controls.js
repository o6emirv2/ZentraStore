const collator = new Intl.Collator('tr', { numeric: true, sensitivity: 'base' });

export function sortRecords(records, mode = 'newest') {
  const rows = [...records];
  return rows.sort((a, b) => {
    if (mode === 'name') return collator.compare(a.name || a.orderNumber || '', b.name || b.orderNumber || '');
    if (mode === 'amount-high') return Number(b.totalKurus || 0) - Number(a.totalKurus || 0);
    if (mode === 'amount-low') return Number(a.totalKurus || 0) - Number(b.totalKurus || 0);
    return mode === 'oldest' ? Number(a.createdAt || 0) - Number(b.createdAt || 0) : Number(b.createdAt || 0) - Number(a.createdAt || 0);
  });
}

export function matchesAdminProduct(product, { query = '', category = 'all', status = 'all' } = {}) {
  const text = `${product.name || ''} ${product.id || ''} ${product.category || ''}`.toLocaleLowerCase('tr-TR');
  if (query.trim() && !text.includes(query.trim().toLocaleLowerCase('tr-TR'))) return false;
  const key = product.categoryKey || (product.category === 'GBox' || /^ios-gbox-/.test(product.id || '') ? 'gbox' : product.inventoryType === 'account' ? 'random-account' : `${product.game}-${product.platform}`);
  if (category !== 'all' && category !== key) return false;
  if (status === 'archived') return product.archived === true;
  if (status === 'active') return product.active !== false && product.archived !== true;
  if (status === 'inactive') return product.active === false && product.archived !== true;
  return true;
}

export function enhanceDataTables(root) {
  root.querySelectorAll('table.data-table:not([data-ui-table])').forEach((table) => {
    table.dataset.uiTable = '';
    const caption = table.createCaption();
    caption.className = 'sr-only';
    caption.textContent = 'Yüklenen stok kayıtları. Sütun başlıklarıyla bu listedeki kayıtları sıralayın.';
    const cells = [...table.tHead?.rows[0]?.cells || []];
    cells.forEach((cell, index) => {
      const label = cell.textContent.trim();
      if (!label || cell.querySelector('button')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.setAttribute('aria-label', `${label}: yüklenen kayıtları sırala`);
      button.addEventListener('click', () => {
        const ascending = cell.getAttribute('aria-sort') !== 'ascending';
        cells.forEach((header) => header.removeAttribute('aria-sort'));
        cell.setAttribute('aria-sort', ascending ? 'ascending' : 'descending');
        const body = table.tBodies[0];
        if (!body) return;
        [...body.rows].sort((a, b) => {
          const left = a.cells[index], right = b.cells[index];
          const l = left?.dataset.sortValue, r = right?.dataset.sortValue;
          const order = l !== undefined && r !== undefined ? Number(l) - Number(r) : collator.compare(left?.textContent || '', right?.textContent || '');
          return ascending ? order : -order;
        }).forEach((row) => body.append(row));
      });
      cell.replaceChildren(button);
    });
  });
}
