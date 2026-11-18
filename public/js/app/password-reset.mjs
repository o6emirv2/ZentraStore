import { createAccountRecovery } from "./account-recovery.mjs?v=109";
import { recoveryToken } from "./recovery-link.mjs?v=109";
import { storeApi, friendlyStoreError } from "../store/api.js?v=109";
import { initStoreIntegrity } from "../store/auth.js?v=109";
import "./device.js?v=109";
import "./ambient.mjs?v=109";

const root = document.getElementById("recovery-root");
const recovery = createAccountRecovery({
  api: async (path, options) => {
    try {
      await initStoreIntegrity();
      return await storeApi(path, { timeoutMs: 25000, ...options });
    } catch (error) {
      throw Object.assign(new Error(friendlyStoreError(error)), {
        code: error.code, status: error.status,
      });
    }
  },
});
const token = recoveryToken(window.location.href);
root.innerHTML = recovery.markup(token);
void recovery.mount(root, token);
window.addEventListener("pagehide", () => recovery.dispose());
