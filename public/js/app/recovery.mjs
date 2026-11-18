import { recoveryDestination } from "./routes.mjs?v=109";
import { installDevicePolicy } from "./device.mjs?v=109";
import "./ambient.mjs?v=109";

installDevicePolicy(document, window);
if (document.body.dataset.recovery === "missing") {
  const target = recoveryDestination(window.location.href);
  if (target) window.location.replace(target);
}
document.querySelector("[data-retry]")?.addEventListener("click", (event) => {
  event.preventDefault();
  window.location.reload();
});
