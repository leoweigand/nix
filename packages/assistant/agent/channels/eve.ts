import { disableRoute } from "eve/channels";
// The worker is the only caller. Do not expose Eve's default session API.
export default disableRoute();
