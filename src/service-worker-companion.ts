// Chromium MV3 service workers support static ES module imports, but not
// dynamic import(). Keep the companion registration in a dedicated build
// entry so the standard extension never includes its native-host surface.
import "./service-worker";
import { registerCompanionService } from "./core/companion/service";

registerCompanionService();
