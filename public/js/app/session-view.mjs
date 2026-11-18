export function dismissPrivateDialogs(doc) {
  for (const dialog of doc.querySelectorAll("dialog.app-dialog")) {
    if (dialog.open) dialog.close();
    dialog.replaceChildren();
    dialog.remove();
  }
  doc.documentElement.classList.remove("dialog-open");
}
export function clearCustomerSessionView(state, doc) {
  state.orders = [];
  state.ordersLoaded = false;
  state.orderCursor = "";
  state.notifications = [];
  state.coupons = [];
  state.promotion = null;
  state.checkoutBusy = false;
  dismissPrivateDialogs(doc);
}
