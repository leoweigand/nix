import { defineSandboxProvider } from "eve/sandbox/provider";

const denied = async (): Promise<never> => {
  throw new Error("Filesystem and shell access are disabled");
};
const connection = {
  spawn: denied,
  readFile: denied,
  writeFiles: denied,
  removePath: denied,
  stop: async () => {},
};

// An explicit provider prevents Docker discovery and denies every file/process operation.
export const NoSandbox = defineSandboxProvider({
  name: "leolab-disabled",
  environment() {
    return {
      async prepare() {
        return {};
      },
      async start() {
        return { connection, state: {} };
      },
      async resume() {
        return connection;
      },
      async onSessionEnd() {},
    };
  },
});
