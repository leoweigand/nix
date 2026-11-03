import { defineSandbox } from "eve/sandbox";
import { NoSandbox } from "../../lib/no-sandbox.ts";
export const environment = NoSandbox.environment();
export default defineSandbox(() => environment.open());
