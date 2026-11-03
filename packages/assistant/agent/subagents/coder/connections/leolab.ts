import { defineDynamic } from "eve/connections";
import { labConnection } from "../../../connections/leolab.ts";
export default defineDynamic((ctx) => labConnection(ctx, true));
