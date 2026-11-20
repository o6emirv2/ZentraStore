import { recoveryDestination } from "./routes.mjs?v=108";
import { installDevicePolicy } from "./device.mjs?v=108";
import "./ambient.mjs?v=108";

installDevicePolicy(document, window);
if (document.body.dataset.recovery === "missing") {
  const target = recoveryDestination(window.location.href);
  if (target) window.location.replace(target);
}
document.querySelector("[data-retry]")?.addEventListener("click", (event) => {
  event.preventDefault();
  window.location.reload();
});
